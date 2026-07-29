// ============================================================
// KONFIGURASI GLOBAL
// ============================================================
const MODEL_PATH    = 'best.onnx';
const INPUT_SIZE    = 640;          // Ukuran input model (640x640)
const CONF_THRESH   = 0.45;         // Ambang batas confidence score
const IOU_THRESH    = 0.45;         // Ambang batas IoU untuk NMS
const CLASSES       = ['Matang', 'Mentah'];
const COLORS        = ['#7C3AED', '#DC2626']; // Ungu = Matang, Merah = Mentah

// Preset kecepatan webcam: semakin kecil interval, semakin sering inference (lebih berat)
//  3 fps = 330ms, 5 fps = 200ms, 8 fps = 125ms — "Akurat" 5fps adalah sweet spot kebanyakan HP
const PERF_PRESETS = {
  cepat:   { name: '⚡ Super Cepat', intervalMs: 500,  label: '330ms / 2fps · Ringan untuk HP lama' },
  normal:  { name: '✅ Normal',      intervalMs: 300,  label: '300ms / 3fps · Seimbang' },
  akurat:  { name: '🎯 Akurat',      intervalMs: 150,  label: '150ms / 6fps · Butuh HP menengah ke atas' }
};
let activePresetKey = 'normal';

let session        = null;   // ONNX InferenceSession
let modelLoadPromise = null;
let webcamStream   = null;   // MediaStream dari kamera
let animFrameId    = null;   // ID requestAnimationFrame (hanya untuk gambar video)
let inferenceTimer = null;   // Timer interval inference (throttle)
let isWebcamActive = false;
let lastDetections = [];     // Cache deteksi terakhir → gambar tiap frame video
let lastFpsSlot    = 0;
let lastFpsFrames  = 0;
let lastInferMs    = 0;

// ============================================================
// INISIALISASI: MUAT MODEL ONNX
//
// Optimasi pemuatan model:
//  1. Pre-fetch best.onnx manual dengan progress bar (lebih transparan)
//  2. Kalau sudah di-cache browser/SW, fetch akan langsung resolve dari cache (instan!)
//  3. Berikan ArrayBuffer ke ort.InferenceSession.create, bukan URL string →
//     ort tidak akan fetch ulang
// ============================================================
function setModelProgress(pct) {
  const bar = document.getElementById('model-progress-bar');
  const txt = document.getElementById('model-progress-text');
  const wrap = document.getElementById('model-progress-wrap');
  if (bar) bar.style.width = Math.max(0, Math.min(100, pct)) + '%';
  if (txt) txt.textContent = Math.max(0, Math.min(100, pct)).toFixed(0) + '%';
  if (wrap) wrap.style.display = (pct >= 0 && pct < 100) ? 'block' : 'none';
}

async function fetchWithProgress(url, onProgress) {
  const res = await fetch(url);
  if (!res.ok) throw new Error('Gagal unduh model (status ' + res.status + ')');
  const total = Number(res.headers.get('content-length') || 0);
  const reader = res.body && res.body.getReader ? res.body.getReader() : null;

  // Tanpa stream (browser lama), fallback ke blob tanpa progress
  if (!reader) {
    if (onProgress) onProgress(15);
    const ab = await res.arrayBuffer();
    if (onProgress) onProgress(100);
    return ab;
  }

  const chunks = [];
  let received = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    received += value.length;
    if (onProgress) {
      const pct = total > 0 ? (received / total) * 100 : Math.min(99, 10 + received / (12 * 1024 * 1024) * 85);
      onProgress(pct);
    }
  }

  // Gabung semua Uint8Array menjadi satu ArrayBuffer
  const u8 = new Uint8Array(received);
  let off = 0;
  for (const c of chunks) { u8.set(c, off); off += c.length; }
  if (onProgress) onProgress(100);
  return u8.buffer;
}

async function loadModel() {
  const STORAGE_KEY = 'best_onnx_cache_v1';
  try {
    ort.env.wasm.wasmPaths = 'https://cdn.jsdelivr.net/npm/onnxruntime-web@1.21.0/dist/';
    ort.env.wasm.simd      = true;     // percepatan SIMD — 30-50% lebih cepat di CPU modern
    ort.env.wasm.numThreads = Math.min(4, (navigator.hardwareConcurrency || 2));

    setStatus('⬇️ Mengunduh model AI (cuma sekali, selanjutnya dari cache)...');
    setModelProgress(2);

    // 1) Fetch best.onnx dengan progress. Kalau sudah di-cache SW/Vercel header,
    //    fetch akan resolve instan dari cache browser (progress langsung ke 100%).
    const modelBuffer = await fetchWithProgress(MODEL_PATH, (pct) => {
      const displayPct = 5 + pct * 0.80; // 5% → 85% adalah unduh model
      setModelProgress(displayPct);
      setStatus(`⬇️ Mengunduh model AI ${displayPct.toFixed(0)}% — (cuma sekali, selanjutnya INSTAN!)`);
    });

    // 2) Opsional: simpan ke IndexedDB/LocalStorage? ArrayBuffer 12MB masih aman di
    //    memory cache biasa. Sebaiknya tidak simpan manual, biarkan Service Worker
    //    + HTTP cache yang mengelola (tidak ada risiko storage limit di JS heap).

    setModelProgress(90);
    setStatus('⚙️ Menyiapkan engine AI di perangkat Anda...');

    // 3) Buat session dari ArrayBuffer — TIDAK fetch ulang!
    session = await ort.InferenceSession.create(modelBuffer, {
      executionProviders: ['webgl', 'webgpu', 'wasm'],
      graphOptimizationLevel: 'all',
      enableMemPattern: true,
      enableCpuMemArena: true
    });

    setModelProgress(100);
    setTimeout(() => setModelProgress(-1), 400); // sembunyikan progress bar
    setStatus('✅ Model siap. Pilih gambar atau nyalakan kamera.');
    return true;

  } catch (e) {
    setModelProgress(-1);
    setStatus('❌ Gagal memuat model: ' + e.message);
    console.error(e);
    return false;
  }
}

function showDetecting(msg) {
  const el = document.getElementById('detecting');
  if (!el) return;
  el.textContent = msg || '⏳ Sedang mendeteksi...';
  el.style.display = 'block';
}

function hideDetecting() {
  const el = document.getElementById('detecting');
  if (!el) return;
  el.style.display = 'none';
}

async function ensureModelReady() {
  if (session) return true;
  if (modelLoadPromise) await modelLoadPromise;
  return !!session;
}

// ============================================================
// DAFTARKAN SERVICE WORKER (untuk cache permanen best.onnx)
// ============================================================
function registerServiceWorker() {
  if (!('serviceWorker' in navigator)) return;
  let registered = false;
  const tryRegister = () => {
    if (registered) return;
    navigator.serviceWorker.register('./sw.js')
      .then((reg) => {
        registered = true;
        console.log('[SW] Service Worker terdaftar — cache permanen aktif. Scope:', reg.scope);
      })
      .catch((err) => {
        console.warn('[SW] Gagal daftar Service Worker:', err);
      });
  };
  tryRegister();
  // Fallback: coba lagi setelah 3 detik (untuk berjaga-jaga jika page load race condition)
  setTimeout(tryRegister, 3000);
}

// ============================================================
// PREPROCESSING — LETTERBOX
//
// Tujuan: Resize gambar ke 640x640 TANPA mengubah rasio aspek.
// Sisa area diisi warna abu-abu (114,114,114) — standar YOLOv8.
//
// Mengapa Letterbox?
//   Jika kita stretch langsung ke 640x640, objek akan tampak gepeng
//   dan koordinat bounding box akan meleset. Letterbox menjaga
//   proporsi asli sehingga model "melihat" gambar seperti saat training.
//
// Return: { canvas, scale, padX, padY }
//   - scale : faktor skala yang digunakan
//   - padX  : padding horizontal (kiri & kanan)
//   - padY  : padding vertikal (atas & bawah)
//   Nilai ini dibutuhkan saat post-processing untuk mengembalikan
//   koordinat box ke ruang koordinat gambar asli.
// ============================================================
function letterbox(imgElement) {
  const canvas = document.createElement('canvas');
  canvas.width  = INPUT_SIZE;
  canvas.height = INPUT_SIZE;
  const ctx = canvas.getContext('2d');

  // 1. Isi seluruh kanvas dengan warna abu-abu (nilai 114 = standar YOLOv8)
  ctx.fillStyle = 'rgb(114,114,114)';
  ctx.fillRect(0, 0, INPUT_SIZE, INPUT_SIZE);

  // 2. Hitung skala agar gambar muat di dalam 640x640 tanpa distorsi
  //    Ambil skala terkecil agar tidak ada sisi yang melebihi 640
  const srcW  = imgElement.videoWidth  || imgElement.naturalWidth  || imgElement.width;
  const srcH  = imgElement.videoHeight || imgElement.naturalHeight || imgElement.height;
  const scale = Math.min(INPUT_SIZE / srcW, INPUT_SIZE / srcH);

  // 3. Ukuran gambar setelah di-scale
  const newW = Math.round(srcW * scale);
  const newH = Math.round(srcH * scale);

  // 4. Hitung padding agar gambar berada di tengah kanvas
  const padX = Math.round((INPUT_SIZE - newW) / 2);
  const padY = Math.round((INPUT_SIZE - newH) / 2);

  // 5. Gambar image yang sudah di-scale ke posisi tengah
  ctx.drawImage(imgElement, padX, padY, newW, newH);

  return { canvas, scale, padX, padY, srcW, srcH };
}

// ============================================================
// KONVERSI IMAGEDATA → TENSOR FLOAT32 (Format NCHW)
//
// Model YOLOv8 mengharapkan input dalam format:
//   [batch, channel, height, width] = [1, 3, 640, 640]
//   dengan nilai piksel dinormalisasi ke rentang [0.0, 1.0]
//
// ImageData dari canvas memiliki format RGBA (4 byte per piksel),
// kita perlu memisahkan channel R, G, B dan membuang channel A.
// ============================================================
function imageToTensor(canvas) {
  const ctx  = canvas.getContext('2d');
  const data = ctx.getImageData(0, 0, INPUT_SIZE, INPUT_SIZE).data;
  // Buffer: 3 channel × 640 × 640 = 1.228.800 elemen
  const tensor = new Float32Array(3 * INPUT_SIZE * INPUT_SIZE);

  const pixelCount = INPUT_SIZE * INPUT_SIZE;
  for (let i = 0; i < pixelCount; i++) {
    // data[i*4+0] = R, data[i*4+1] = G, data[i*4+2] = B, data[i*4+3] = A (diabaikan)
    // Normalisasi: bagi 255 agar nilai masuk ke [0, 1]
    tensor[0 * pixelCount + i] = data[i * 4 + 0] / 255.0; // Channel R
    tensor[1 * pixelCount + i] = data[i * 4 + 1] / 255.0; // Channel G
    tensor[2 * pixelCount + i] = data[i * 4 + 2] / 255.0; // Channel B
  }

  return new ort.Tensor('float32', tensor, [1, 3, INPUT_SIZE, INPUT_SIZE]);
}

// ============================================================
// INFERENCE: JALANKAN MODEL
// ============================================================
async function runInference(imgElement) {
  if (!session) return [];

  // Langkah 1: Preprocessing
  const { canvas, scale, padX, padY, srcW, srcH } = letterbox(imgElement);
  const inputTensor = imageToTensor(canvas);

  // Langkah 2: Jalankan model
  const inputName = session.inputNames[0];
  const results   = await session.run({ [inputName]: inputTensor });

  // Langkah 3: Ambil output tensor
  const outputName = session.outputNames[0];
  const output     = results[outputName]; // Shape: [1, 6, 8400]

  // Langkah 4: Post-processing
  return postprocess(output.data, output.dims, scale, padX, padY, srcW, srcH);
}

// ============================================================
// POST-PROCESSING — EKSTRAKSI BOUNDING BOX + NMS
//
// Output model YOLOv8 memiliki shape [1, 6, 8400]:
//   - Dimensi 1 (6 fitur): [cx, cy, w, h, score_kelas0, score_kelas1]
//   - Dimensi 2 (8400 anchor): setiap anchor adalah satu kandidat deteksi
//
// Koordinat cx, cy, w, h berada dalam ruang model (0–640).
// Kita perlu mengubahnya kembali ke koordinat gambar asli dengan
// membalik transformasi letterbox: kurangi padding, bagi dengan skala.
// ============================================================
function postprocess(data, dims, scale, padX, padY, srcW, srcH) {
  const numAnchors  = dims[2]; // 8400
  const numFeatures = dims[1]; // 6

  const candidates = [];

  for (let i = 0; i < numAnchors; i++) {
    // Akses data dalam format [feature][anchor]:
    // index = feature * numAnchors + anchor
    const cx = data[0 * numAnchors + i]; // Pusat X (koordinat model)
    const cy = data[1 * numAnchors + i]; // Pusat Y (koordinat model)
    const w  = data[2 * numAnchors + i]; // Lebar box (koordinat model)
    const h  = data[3 * numAnchors + i]; // Tinggi box (koordinat model)
    const s0 = data[4 * numAnchors + i]; // Score kelas 0 (Matang)
    const s1 = data[5 * numAnchors + i]; // Score kelas 1 (Mentah)

    // Tentukan kelas dengan score tertinggi
    const classId = s0 >= s1 ? 0 : 1;
    const conf    = classId === 0 ? s0 : s1;

    // Buang deteksi dengan confidence di bawah threshold
    if (conf < CONF_THRESH) continue;

    // Konversi cx,cy,w,h → x1,y1,x2,y2 (masih dalam koordinat model)
    const x1_model = cx - w / 2;
    const y1_model = cy - h / 2;
    const x2_model = cx + w / 2;
    const y2_model = cy + h / 2;

    // ── Inverse Letterbox Transform ──────────────────────────
    // Kembalikan koordinat dari ruang model (0–640) ke ruang gambar asli.
    // Rumus: coord_asli = (coord_model - padding) / scale
    // Clamp agar tidak keluar batas gambar asli.
    const x1 = Math.max(0, Math.min(srcW, (x1_model - padX) / scale));
    const y1 = Math.max(0, Math.min(srcH, (y1_model - padY) / scale));
    const x2 = Math.max(0, Math.min(srcW, (x2_model - padX) / scale));
    const y2 = Math.max(0, Math.min(srcH, (y2_model - padY) / scale));
    // ─────────────────────────────────────────────────────────

    candidates.push({ x1, y1, x2, y2, conf, classId });
  }

  // Terapkan NMS per kelas
  const detections = [];
  for (let c = 0; c < CLASSES.length; c++) {
    const classBoxes = candidates.filter(d => d.classId === c);
    const kept = nms(classBoxes, IOU_THRESH);
    detections.push(...kept);
  }

  return detections;
}

// ============================================================
// NON-MAXIMUM SUPPRESSION (NMS)
//
// Masalah: Model menghasilkan banyak box yang saling tumpang tindih
// untuk objek yang sama. NMS memilih hanya box terbaik.
//
// Algoritma:
//   1. Urutkan box berdasarkan confidence (tertinggi dulu)
//   2. Ambil box dengan confidence tertinggi → masukkan ke hasil
//   3. Hapus semua box lain yang IoU-nya > threshold dengan box terpilih
//   4. Ulangi sampai tidak ada box tersisa
// ============================================================
function nms(boxes, iouThreshold) {
  // Urutkan descending berdasarkan confidence
  boxes.sort((a, b) => b.conf - a.conf);

  const kept = [];
  const suppressed = new Array(boxes.length).fill(false);

  for (let i = 0; i < boxes.length; i++) {
    if (suppressed[i]) continue;
    kept.push(boxes[i]);

    for (let j = i + 1; j < boxes.length; j++) {
      if (suppressed[j]) continue;
      // Jika IoU melebihi threshold, box j dianggap duplikat → hapus
      if (computeIoU(boxes[i], boxes[j]) > iouThreshold) {
        suppressed[j] = true;
      }
    }
  }

  return kept;
}

// Hitung Intersection over Union (IoU) antara dua bounding box
function computeIoU(a, b) {
  const interX1 = Math.max(a.x1, b.x1);
  const interY1 = Math.max(a.y1, b.y1);
  const interX2 = Math.min(a.x2, b.x2);
  const interY2 = Math.min(a.y2, b.y2);

  const interW = Math.max(0, interX2 - interX1);
  const interH = Math.max(0, interY2 - interY1);
  const intersection = interW * interH;

  const areaA = (a.x2 - a.x1) * (a.y2 - a.y1);
  const areaB = (b.x2 - b.x1) * (b.y2 - b.y1);
  const union = areaA + areaB - intersection;

  return union <= 0 ? 0 : intersection / union;
}

// ============================================================
// VISUALISASI: GAMBAR BOUNDING BOX DI CANVAS
// ============================================================
function drawBoxes(ctx, detections, scaleX, scaleY) {
  detections.forEach(({ x1, y1, x2, y2, conf, classId }) => {
    const color = COLORS[classId];
    const label = `${CLASSES[classId]} ${(conf * 100).toFixed(1)}%`;

    const sx1 = x1 * scaleX, sy1 = y1 * scaleY;
    const sx2 = x2 * scaleX, sy2 = y2 * scaleY;

    ctx.strokeStyle = color;
    ctx.lineWidth   = 5;
    ctx.strokeRect(sx1, sy1, sx2 - sx1, sy2 - sy1);

    ctx.font = 'bold 32px Segoe UI, sans-serif';
    const textW = ctx.measureText(label).width;
    const boxH  = 44;
    ctx.fillStyle = color;
    ctx.fillRect(sx1 - 2, sy1 - boxH - 4, textW + 20, boxH);

    ctx.fillStyle = '#ffffff';
    ctx.fillText(label, sx1 + 8, sy1 - 14);
  });
}

// ============================================================
// HELPER: UPDATE STATUS
// ============================================================
function setStatus(msg) {
  const el = document.getElementById('status');
  if (el) el.textContent = msg;
}

// ============================================================
// HELPER: UPDATE PANEL HASIL DETEKSI (angka + persentase)
// detections = [{x1,y1,x2,y2,conf,classId}, ...]
// Kelas 0 = Matang (ungu), Kelas 1 = Mentah (merah)
// ============================================================
function updateResultPanel(detections) {
  const chip = document.getElementById('result-chip');
  const countM = document.getElementById('count-matang');
  const countMe = document.getElementById('count-mentah');
  const pctM = document.getElementById('pct-matang');
  const pctMe = document.getElementById('pct-mentah');
  const barM = document.getElementById('bar-matang');
  const barMe = document.getElementById('bar-mentah');
  const accM = document.getElementById('acc-matang');
  const accMe = document.getElementById('acc-mentah');
  const accBarM = document.getElementById('acc-bar-matang');
  const accBarMe = document.getElementById('acc-bar-mentah');
  const summary = document.getElementById('result-summary');

  const matangList = detections.filter(d => d.classId === 0);
  const mentahList = detections.filter(d => d.classId === 1);
  const total = detections.length;
  const countMVal = matangList.length;
  const countMeVal = mentahList.length;
  const pctMVal = total === 0 ? 0 : Math.round((countMVal / total) * 100);
  const pctMeVal = total === 0 ? 0 : Math.round((countMeVal / total) * 100);

  // Rata-rata confidence (akurasi rata-rata) per kelas, dalam persen
  const avgConf = (arr) => arr.length === 0 ? 0 :
    arr.reduce((s, d) => s + d.conf, 0) / arr.length;
  const avgMatang = avgConf(matangList);
  const avgMentah = avgConf(mentahList);
  const avgMatangPct = Math.round(avgMatang * 1000) / 10; // 1 desimal
  const avgMentahPct = Math.round(avgMentah * 1000) / 10;

  // Jumlah + Persentase
  if (countM) countM.textContent = countMVal;
  if (countMe) countMe.textContent = countMeVal;
  if (pctM) pctM.textContent = pctMVal + '%';
  if (pctMe) pctMe.textContent = pctMeVal + '%';
  if (barM) barM.style.width = pctMVal + '%';
  if (barMe) barMe.style.width = pctMeVal + '%';

  // ⭐ AKURASI RATA-RATA PER KELAS (yang baru!)
  if (accM) accM.textContent = countMVal > 0 ? (avgMatangPct + '%') : '—';
  if (accMe) accMe.textContent = countMeVal > 0 ? (avgMentahPct + '%') : '—';
  if (accBarM) accBarM.style.width = countMVal > 0 ? avgMatangPct + '%' : '0%';
  if (accBarMe) accBarMe.style.width = countMeVal > 0 ? avgMentahPct + '%' : '0%';

  // Chip status + summary teks
  if (chip) {
    chip.classList.remove('ok', 'warn', 'ng');
    if (total === 0) {
      chip.textContent = 'Belum ada data';
    } else if (countMVal > countMeVal) {
      chip.textContent = '✅ Sebagian Besar Matang';
      chip.classList.add('ok');
    } else if (countMeVal > countMVal) {
      chip.textContent = '⚠️ Sebagian Besar Mentah';
      chip.classList.add('warn');
    } else {
      chip.textContent = '🔀 Seimbang';
      chip.classList.add('warn');
    }
  }

  if (summary) {
    if (total === 0) {
      summary.innerHTML = 'Belum ada data deteksi. Silakan pilih foto atau nyalakan kamera terlebih dahulu.';
    } else {
      const sM = countMVal > 0 ? `📊 persen dari total <strong>${pctMVal}%</strong> · 🎯 rata-rata keyakinan AI <strong>${avgMatangPct}%</strong>` : '';
      const sMe = countMeVal > 0 ? `📊 persen dari total <strong>${pctMeVal}%</strong> · 🎯 rata-rata keyakinan AI <strong>${avgMentahPct}%</strong>` : '';

      const ringkasan = [];
      ringkasan.push(`🧺 Total terdeteksi <strong>${total} buah</strong> → Matang <strong>${countMVal}</strong> · Mentah <strong>${countMeVal}</strong>.`);

      if (countMVal > 0) ringkasan.push(`🍇 <strong>Matang</strong>: ${sM}.`);
      if (countMeVal > 0) ringkasan.push(`🍓 <strong>Mentah</strong>: ${sMe}.`);

      if (pctMVal >= 70) {
        ringkasan.push('🌿 Sebagian besar buah sudah <strong>siap dipanen</strong>.');
      } else if (pctMeVal >= 70) {
        ringkasan.push('🌱 Sebagian besar buah masih <strong>belum siap dipanen</strong>, tunggu beberapa hari lagi.');
      } else {
        ringkasan.push('🧺 Ada campuran buah matang dan mentah, panen secara bertahap sesuai tingkat kematangan.');
      }

      summary.innerHTML = ringkasan.join(' ');
    }
  }
}

// ============================================================
// SWITCH MODE: UPLOAD vs WEBCAM
// ============================================================
function switchMode(mode) {
  const tabUpload  = document.getElementById('tab-upload');
  const tabWebcam  = document.getElementById('tab-webcam');
  const ctrlUpload = document.getElementById('ctrl-upload');
  const ctrlWebcam = document.getElementById('ctrl-webcam');
  const canvas     = document.getElementById('canvas');
  const placeholder = document.getElementById('placeholder');
  const detecting = document.getElementById('detecting');

  if (mode === 'upload') {
    tabUpload.classList.add('active');
    tabWebcam.classList.remove('active');
    ctrlUpload.classList.remove('hidden');
    ctrlWebcam.classList.add('hidden');
    stopWebcam();
    canvas.width = 0; canvas.height = 0;
    placeholder.style.display = 'block';
    if (detecting) detecting.style.display = 'none';
    updateResultPanel([]);
  } else {
    tabUpload.classList.remove('active');
    tabWebcam.classList.add('active');
    ctrlUpload.classList.add('hidden');
    ctrlWebcam.classList.remove('hidden');
    placeholder.style.display = 'none';
    if (detecting) detecting.style.display = 'none';
    updateResultPanel([]);
  }
}

// ============================================================
// RENDER & DETEKSI GAMBAR (UPLOAD MODE)
// ============================================================
async function detectImage(imgElement) {
  const canvas      = document.getElementById('canvas');
  const ctx         = canvas.getContext('2d');
  const placeholder = document.getElementById('placeholder');
  const detecting   = document.getElementById('detecting');

  showDetecting('⏳ Menyiapkan deteksi...');
  const ready = await ensureModelReady();
  if (!ready) {
    hideDetecting();
    setStatus('⏳ Model AI belum siap. Coba tunggu sebentar lalu ulangi.');
    return;
  }

  const srcW = imgElement.videoWidth || imgElement.naturalWidth || imgElement.width;
  const srcH = imgElement.videoHeight || imgElement.naturalHeight || imgElement.height;

  canvas.width  = srcW;
  canvas.height = srcH;
  placeholder.style.display = 'none';
  if (detecting) detecting.style.display = 'block';

  ctx.drawImage(imgElement, 0, 0, srcW, srcH);

  let detections = [];
  try {
    showDetecting('⏳ Sedang mendeteksi...');
    setStatus('🔍 Menganalisis gambar...');
    detections = await runInference(imgElement);
    drawBoxes(ctx, detections, 1, 1);
    updateResultPanel(detections);
  } finally {
    if (detecting) detecting.style.display = 'none';
  }

  if (detections.length === 0) {
    setStatus('ℹ️ Tidak ada objek terdeteksi.');
  } else {
    const matang = detections.filter(d => d.classId === 0).length;
    const mentah = detections.filter(d => d.classId === 1).length;
    setStatus(`✅ Terdeteksi: ${matang} Matang, ${mentah} Mentah`);
  }
}

// ============================================================
// FILE INPUT HANDLER
// ============================================================
function setStatusFrozen(frozen) {
  const el = document.getElementById('status');
  if (!el) return;
  el.dataset.frozen = frozen ? '1' : '0';
}

async function fileToImageSource(file) {
  if (window.createImageBitmap) {
    try {
      return await createImageBitmap(file, { imageOrientation: 'from-image' });
    } catch {}
    try {
      return await createImageBitmap(file);
    } catch {}
  }

  return await new Promise((resolve, reject) => {
    const img = new Image();
    const url = URL.createObjectURL(file);
    img.onload = () => { URL.revokeObjectURL(url); resolve(img); };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('Gagal memuat gambar')); };
    img.src = url;
  });
}

function setupFileInputElement(inputId) {
  const input = document.getElementById(inputId);
  if (!input) return;

  input.addEventListener('change', async (e) => {
    const file = e.target.files && e.target.files[0];
    if (!file) return;
    try {
      setStatusFrozen(true);
      showDetecting('⏳ Memproses foto...');
      setStatus('⏳ Memproses foto...');
      const src = await fileToImageSource(file);
      await detectImage(src);
    } catch (err) {
      hideDetecting();
      setStatus('❌ Gagal memproses gambar: ' + (err && err.message ? err.message : String(err)));
    } finally {
      hideDetecting();
      setStatusFrozen(false);
      input.value = '';
    }
  });
}

function setupFileInputs() {
  setupFileInputElement('file-input');
  setupFileInputElement('camera-input');
}

// ============================================================
// WEBCAM: TOGGLE ON/OFF
// ============================================================
async function toggleWebcam() {
  if (isWebcamActive) {
    stopWebcam();
  } else {
    await startWebcam();
  }
}

function setWebcamButton(active) {
  const btn = document.getElementById('btn-webcam');
  if (!btn) return;
  if (active) {
    btn.innerHTML = '<span>🛑</span> Matikan Kamera';
    btn.classList.add('danger');
  } else {
    btn.innerHTML = '<span>📷</span> Nyalakan Kamera';
    btn.classList.remove('danger');
  }
}

async function startWebcam() {
  const video = document.createElement('video');
  video.setAttribute('playsinline', '');
  video.setAttribute('autoplay', '');
  video.setAttribute('muted', '');
  video.setAttribute('webkit-playsinline', '');

  try {
    const prefW = window.innerWidth < 720 ? 640 : 1280;
    const prefH = window.innerWidth < 720 ? 480 : 720;

    webcamStream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: 'environment', width: { ideal: prefW }, height: { ideal: prefH } },
      audio: false
    });
    video.srcObject = webcamStream;
    await video.play();

    isWebcamActive = true;
    lastDetections = [];
    window.__camVideoEl = video;
    setWebcamButton(true);

    // ── Arsitektur 2 loop: render vs inference terpisah ──
    startRenderLoop(video);
    startInferenceLoop(video);
  } catch (e) {
    setStatus('❌ Gagal mengakses kamera: ' + e.message);
    console.error(e);
  }
}

function stopWebcam() {
  isWebcamActive = false;

  if (animFrameId) { cancelAnimationFrame(animFrameId); animFrameId = null; }
  if (inferenceTimer) { clearInterval(inferenceTimer); inferenceTimer = null; }
  if (webcamStream) { webcamStream.getTracks().forEach(t => t.stop()); webcamStream = null; }
  lastDetections = [];
  hideDetecting();
  setWebcamButton(false);
}

// ============================================================
// LOOP 1: RENDER VIDEO + BOX — SELALU LANCAR (30-60 FPS)
// Tidak menunggu inference. Hanya gambar video + gambar boxes dari cache.
// ============================================================
function startRenderLoop(video) {
  const canvas = document.getElementById('canvas');
  const ctx    = canvas.getContext('2d', { alpha: false });
  lastFpsSlot = performance.now();
  lastFpsFrames = 0;

  function render() {
    if (!isWebcamActive) return;
    const videoW = video.videoWidth;
    const videoH = video.videoHeight;
    if (videoW > 0 && videoH > 0) {
      if (canvas.width !== videoW || canvas.height !== videoH) {
        canvas.width = videoW;
        canvas.height = videoH;
      }
      ctx.drawImage(video, 0, 0, videoW, videoH);
      if (lastDetections.length) drawBoxes(ctx, lastDetections, 1, 1);
    }
    // Hitung FPS (setiap 1 detik, tampilkan di status bar
    lastFpsFrames++;
    const now = performance.now();
    if (now - lastFpsSlot >= 1000) {
      const fps = Math.round(lastFpsFrames * 1000 / (now - lastFpsSlot));
      const preset = PERF_PRESETS[activePresetKey];
      const info = `🎥 FPS: ${fps} · Latensi AI: ${lastInferMs ? (lastInferMs|0) + 'ms' : '—'} · Mode: ${preset.name}`;
      setStatusWebcam(info);
      lastFpsSlot = now;
      lastFpsFrames = 0;
    }
    animFrameId = requestAnimationFrame(render);
  }
  render();
}

// ============================================================
// LOOP 2: INFERENCE THROTTLED — HANYA per interval tertentu
// Tidak block loop render. Hasil disimpan ke cache lastDetections.
// ============================================================
function startInferenceLoop(video) {
  let inFlight = false; // hindari tumpang tindih inference
  const preset = PERF_PRESETS[activePresetKey];
  if (inferenceTimer) clearInterval(inferenceTimer);
  let overlayTimer = null;

  const tick = async () => {
    if (!isWebcamActive || inFlight) return;
    if (!(video.videoWidth > 0 && video.videoHeight > 0)) return;
    if (!session) {
      showDetecting('⏳ Menunggu model AI...');
      return;
    }
    inFlight = true;
    const t0 = performance.now();
    if (overlayTimer) clearTimeout(overlayTimer);
    overlayTimer = setTimeout(() => {
      if (inFlight && isWebcamActive) showDetecting('⏳ Sedang mendeteksi...');
    }, 160);
    try {
      const det = await runInference(video);
      lastInferMs = performance.now() - t0;
      lastDetections = det;
      // Batasi update panel hasil: tiap 2x inference saja agar tidak lag
      throttledResultPanel(det);
    } finally {
      inFlight = false;
      if (overlayTimer) { clearTimeout(overlayTimer); overlayTimer = null; }
      hideDetecting();
    }
  };
  inferenceTimer = setInterval(tick, preset.intervalMs);
  tick();
}

// ============================================================
// THROTTLE updateResultPanel: max 1x per 400ms supaya DOM tidak ramai
// ============================================================
let _lastPanelTimer = 0;
let _pendingPanel = null;
function throttledResultPanel(detections) {
  _pendingPanel = detections;
  const now = performance.now();
  if (!_lastPanelTimer || now - _lastPanelTimer >= 400) {
    updateResultPanel(_pendingPanel);
    _lastPanelTimer = now;
    _pendingPanel = null;
  } else {
    if (!window._throttlePanelScheduled) {
      window._throttlePanelScheduled = true;
      setTimeout(() => {
        window._throttlePanelScheduled = false;
        if (_pendingPanel !== null) {
          updateResultPanel(_pendingPanel);
          _pendingPanel = null;
          _lastPanelTimer = performance.now();
        }
      }, 420);
    }
  }
}

// ============================================================
// Helper: tampilkan status webcam (jangan timpa status umum)
// ============================================================
function setStatusWebcam(msg) {
  const el = document.getElementById('status');
  if (!el) return;
  if (!el.dataset.frozen || el.dataset.frozen !== '1') el.textContent = msg;
}

// ============================================================
// Ubah preset kecepatan (dipanggil saat user pilih select)
// ============================================================
function setPerfPreset(key) {
  if (!PERF_PRESETS[key]) key = 'normal';
  activePresetKey = key;
  // Restart inference loop dengan interval baru, JIKA webcam sedang aktif
  const infoLabel = document.getElementById('perf-info');
  if (infoLabel) infoLabel.textContent = PERF_PRESETS[key].label;
  if (isWebcamActive && webcamStream) {
    // Cari elemen video yang tersimpan — buat ulang loop inference
    // Karena kita tidak simpan referensi global, cara termudah: restart webcam
    // Alternatif: cari video element terpisah. Kita simpan sebagai window saja.
    const v = window.__camVideoEl;
    if (v) startInferenceLoop(v);
  }
}

// ============================================================
// INISIALISASI APLIKASI
// ============================================================
document.addEventListener('DOMContentLoaded', () => {
  registerServiceWorker();
  setupFileInputs();
  modelLoadPromise = loadModel();
});
