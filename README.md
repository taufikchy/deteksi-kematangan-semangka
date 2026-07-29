# Deteksi Kematangan Semangka (Web App)

Dokumen ini menjelaskan aplikasi web deteksi kematangan semangka berbasis AI yang berjalan langsung di perangkat pengguna (HP/laptop) tanpa perlu mengunggah gambar ke server. Dokumen ini dapat digunakan sebagai bahan penjelasan untuk Sub Bab 4.6.1 (Perencanaan Sistem) pada skripsi.

## 1. Gambaran Umum

**Nama aplikasi:** Deteksi Kematangan Semangka  
**Tujuan:** Membantu pengguna (petani/pengunjung agrowisata) mengidentifikasi semangka **matang** dan **mentah** dari foto atau kamera secara cepat dan praktis.  
**Pendekatan:** Inferensi AI dilakukan **client-side** (di browser) menggunakan model YOLOv8 yang diekspor ke format ONNX.

### 1.1 Manfaat

- Proses deteksi dilakukan di perangkat pengguna: lebih privat, hemat kuota, dan responsif.
- Cocok untuk penggunaan lapangan (agrowisata) karena UI dibuat sederhana dan ramah HP.
- Hasil deteksi divisualisasikan dengan bounding box + ringkasan metrik.

## 2. Fitur Utama

- **Mode Upload Foto:** pengguna memilih gambar dari galeri untuk dideteksi.
- **Mode Kamera Live:** deteksi real-time menggunakan kamera perangkat (membutuhkan HTTPS).
- **Bounding Box + Label:** menampilkan lokasi objek dan confidence per objek.
- **Panel Hasil Deteksi (2 Kelas):**
  - **Jumlah buah** per kelas (Matang/Mentah).
  - **Proporsi jumlah deteksi** (komposisi jumlah buah dari semua deteksi).
  - **Rata-rata keyakinan AI** (rata-rata confidence YOLO; konsisten dengan label di bounding box).
- **Pengaturan Kecepatan Deteksi:** preset untuk menyeimbangkan performa vs ketelitian (terutama pada HP).
- **Caching Model (Service Worker):** model `best.onnx` disimpan di cache agar pemuatan berikutnya lebih cepat dan stabil.
- **PWA & Ikon Aplikasi:** mendukung pemasangan shortcut di layar utama (Android/iOS) via `manifest.json`.

## 3. Teknologi yang Digunakan

### 3.1 Bahasa & Teknologi Frontend

- **HTML**: struktur halaman dan komponen UI.
- **CSS**: desain antarmuka (responsif mobile).
- **JavaScript**: logika aplikasi (kamera, inferensi, rendering canvas, UI state).

### 3.2 AI / Machine Learning (di Browser)

- **YOLOv8** sebagai model deteksi objek (2 kelas: Matang & Mentah).
- **ONNX Runtime Web** untuk menjalankan model ONNX di browser.
- **Format model:** `best.onnx` (dimuat di sisi klien).

### 3.3 PWA & Offline

- **Service Worker**: `sw.js` untuk caching asset dan model agar pemuatan ulang lebih cepat.
- **Web App Manifest**: `manifest.json` untuk pemasangan aplikasi pada layar utama (Add to Home Screen).

### 3.4 Deploy

- **Vercel** (static hosting) sebagai platform deployment.

## 4. Perencanaan Sistem (Sub Bab 4.6.1)

Bagian ini menjelaskan rancangan sistem secara ringkas, meliputi input, proses, output, dan komponen utama.

### 4.1 Input Sistem

- **Gambar** (JPG/PNG) dari galeri pengguna (mode Upload).
- **Frame video** dari kamera perangkat (mode Kamera Live).

### 4.2 Proses Sistem (Alur Kerja)

1. Pengguna memilih mode: **Upload Foto** atau **Kamera Live**.
2. Aplikasi memuat model AI `best.onnx` di browser (sekali, kemudian dicache).
3. Aplikasi mengubah input (gambar/frame video) menjadi ukuran input model (mis. 640×640) dan membuat tensor.
4. ONNX Runtime Web menjalankan inferensi YOLOv8 (menghasilkan prediksi bounding box + confidence + class).
5. Aplikasi melakukan post-processing:
   - filtering confidence threshold,
   - NMS (jika digunakan),
   - konversi koordinat ke ukuran canvas.
6. Aplikasi merender hasil ke canvas:
   - menggambar bounding box,
   - menggambar label (kelas + confidence).
7. Aplikasi menghitung metrik ringkasan dan menampilkan ke panel hasil.

### 4.3 Output Sistem

- **Visual output:** bounding box dan label di canvas.
- **Output metrik:** panel hasil deteksi menampilkan:
  - Jumlah buah Matang & Mentah,
  - Proporsi jumlah deteksi (komposisi jumlah),
  - Rata-rata keyakinan AI per kelas (rata-rata confidence YOLO).

### 4.4 Komponen Sistem

- **UI Layer (HTML/CSS):** tampilan kontrol mode, tombol, status, panel metrik.
- **Logic Layer (JavaScript):** manajemen state, event handler, loop render, dan loop inferensi.
- **Inference Engine:** ONNX Runtime Web.
- **Model:** `best.onnx` (YOLOv8).
- **Offline/Caching:** Service Worker (`sw.js`) + cache storage browser.

### 4.5 Batasan & Asumsi

- Fitur kamera di browser umumnya membutuhkan **HTTPS**.
- Performa dipengaruhi oleh spesifikasi perangkat (HP low-end disarankan memakai preset “Super Cepat”).
- Confidence pada bounding box adalah “keyakinan model”, bukan akurasi absolut; akurasi akhir tetap dipengaruhi kualitas data latih, kondisi cahaya, dan sudut pengambilan gambar.

## 5. Cara Menggunakan Aplikasi

### 5.1 Mode Upload Foto

1. Buka aplikasi di browser.
2. Pilih preset **Atur Kecepatan Deteksi** sesuai perangkat.
3. Tekan tombol **Pilih Gambar dari Galeri**.
4. Pilih foto semangka.
5. Hasil muncul otomatis:
   - bounding box pada gambar,
   - ringkasan metrik pada panel hasil.

### 5.2 Mode Kamera Live

1. Buka aplikasi melalui **HTTPS**.
2. Pilih preset **Atur Kecepatan Deteksi**.
3. Pilih tab **Kamera Live**.
4. Tekan tombol **Nyalakan Kamera** dan izinkan akses kamera.
5. Arahkan kamera ke objek semangka dan amati hasil deteksi pada canvas dan panel metrik.

## 6. Struktur Berkas Proyek

- `index.html`: halaman utama (UI).
- `style.css`: styling UI.
- `script.js`: logika aplikasi, inferensi, rendering, dan perhitungan metrik.
- `best.onnx`: model YOLOv8 dalam format ONNX.
- `sw.js`: service worker untuk caching asset dan model.
- `manifest.json`: konfigurasi PWA (nama aplikasi, ikon, dll).
- `icon-192.png`, `icon-512.png`, `favicon.ico`, `favicon.svg`: ikon aplikasi.
- `vercel.json`: konfigurasi deployment (Vercel).

## 7. Catatan Interpretasi Metrik

Untuk menghindari kebingungan:

- **Proporsi Jumlah Deteksi** = (jumlah kelas / total deteksi) × 100%. Ini persentase berdasarkan **jumlah buah** pada kelas tersebut dibanding total buah terdeteksi. **Bukan akurasi.**
- **Rata-rata Keyakinan AI** = rata-rata confidence YOLO untuk kelas tersebut, ini yang konsisten dengan **angka pada label bounding box**.
