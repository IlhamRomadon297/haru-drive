# 🌸 HaruDrive Pro - Cloud Index & Storage Platform

**HaruDrive** adalah sistem penyimpanan cloud dan indeks file modern berbasis serverless. Ditenagai oleh **Cloudflare Workers / Pages** sebagai front-facing proxy berkecepatan tinggi dan **Hugging Face Dataset (LFS)** sebagai backend penyimpanan gratis tanpa batas (hingga 8.7 TB+), serta terintegrasi dengan **Google Drive API v3 Mirroring**.

---

## 🌟 Fitur Utama

- **🚀 Backend Penyimpanan 8.7 TB+ Gratis & Tanpa Batas:**
  Menyimpan seluruh video, episode serial, film, dan file besar di Hugging Face Public Dataset LFS tanpa membebani server sendiri.
- **⚡ Zero-Copy Stream Pipe:**
  Streaming video 1080p langsung ke pengguna tanpa buffering, tanpa beban RAM, dan tanpa batasan waktu CPU Cloudflare Workers.
- **🗂️ Tampilan Kartu Terfokus untuk Pengunjung (Guest Mode):**
  Desain antarmuka publik yang bersih, elegan, dan terpusat di tengah dengan navigasi folder, pencarian kilat (Ctrl+K), multi-select download, dan copy share link per folder/file.
- **🎬 Built-in Plyr Video Player:**
  Pemutar video modern berbasis Plyr dengan kontrol kecepatan, subtitle, fullscreen, dan autoplay dimatikan secara default.
- **⚡ Operasi Pindah & Ganti Nama Atomik (0.2 Detik):**
  Memindahkan atau mengganti nama puluhan gigabyte file secara instan tanpa perlu unduh-ulang menggunakan protokol resmi Hugging Face NDJSON.
- **🔄 Ultra-Speed Batch Colab Mirror (1-Commit-per-Batch):**
  Alat migrasi multi-threaded di Google Colab yang mengunduh paralel dari Google Drive dan mengunggah dalam kloter batch teratur (1 Commit per batch) agar **bebas dari batasan commit rate limit**.
- **📊 Live Cloud Task Manager:**
  Lacak proses mirror GitHub Actions secara langsung dari dashboard admin dengan indikator status real-time dan tombol batalkan 1-klik.

---

## 🏗️ Arsitektur Sistem

```
┌─────────────────┐       ┌────────────────────────┐       ┌──────────────────────┐
│  Pengunjung /   │ ────> │   Cloudflare Pages     │ ────> │ Hugging Face Dataset │
│  Admin Web      │ <──── │ (Edge Worker + D1 DB)  │ <──── │ (Storage LFS 8.7TB+) │
└─────────────────┘       └────────────────────────┘       └──────────────────────┘
                                      │
                                      ▼
                          ┌────────────────────────┐
                          │ Google Colab / Actions │
                          │ (Multi-Threaded Mirror)│
                          └────────────────────────┘
```

1. **Edge Proxy:** Cloudflare Pages Worker menangani routing, caching, proteksi admin, dan streaming stream pipe.
2. **Database:** Cloudflare D1 (SQLite) menyimpan struktur shortlink dan cache pohon file.
3. **Storage:** Hugging Face Git LFS menyimpan blob file asli.
4. **Mirror Pipeline:** Google Colab / GitHub Actions menyedot file dari Google Drive via OAuth2 v3 dan mengunggah ke Hugging Face.

---

## 🚀 Panduan Instalasi & Deploy Sendiri (Forking)

Bagi Anda yang ingin meng-cloning atau meng-fork repositori ini untuk kebutuhan pribadi:

### 1. Fork Repositori
Klik tombol **Fork** di pojok kanan atas repositori ini ke akun GitHub Anda.

### 2. Siapkan Hugging Face Dataset
1. Buat akun di [Hugging Face](https://huggingface.co).
2. Buat **Dataset Baru** (pilih visibilitas **Public** agar kuota 8.7 TB gratis aktif).
3. Buat Access Token di **Settings > Access Tokens** dengan permission **Write**.

### 3. Konfigurasi Cloudflare Pages
1. Hubungkan akun Cloudflare Anda ke repositori GitHub yang sudah di-fork.
2. Buat project **Cloudflare Pages** baru:
   - **Framework Preset:** None
   - **Build output directory:** `public`
3. Tambahkan **Environment Variables / Secrets** di menu *Settings > Environment variables*:
   - `HF_TOKEN`: Token Write Hugging Face Anda.
   - `HF_REPO_ID`: `username/nama-dataset-anda`
   - `ADMIN_PIN`: PIN 6 digit untuk login dashboard admin.
   - `APP_PASSWORD`: Password aplikasi Anda.
   - `GITHUB_PAT`: Personal Access Token GitHub (izin `repo` dan `workflow`).
   - `GITHUB_REPO`: `username/haru-drive`

### 4. Menggunakan Google Colab Mirror
Buka file `tools/HaruDrive_Colab_Mirror.ipynb` di Google Colab:
1. Klik ikon **Kunci (🔑 Secrets)** di panel sidebar kiri Colab.
2. Tambahkan rahasia berikut dan aktifkan saklar **"Notebook access"**:
   - `GDRIVE_CLIENT_ID`: Client ID OAuth Google Cloud Console.
   - `GDRIVE_CLIENT_SECRET`: Client Secret Google Cloud Console.
   - `GDRIVE_REFRESH_TOKEN`: Refresh Token OAuth Google Drive.
   - `HF_TOKEN`: Token Write Hugging Face Anda.
3. Masukkan link folder Google Drive dan jalankan cell untuk memindahkan file secara otomatis!

---

## 📂 Struktur Repositori

```
haru-drive/
├── .github/workflows/
│   ├── deploy.yml            # Otomatisasi deploy ke Cloudflare Pages
│   └── mirror.yml            # Workflow remote cloud mirror
├── public/
│   └── _worker.js            # Monolithic Cloudflare Worker script
├── src/
│   └── worker.js             # Source worker
├── tools/
│   └── HaruDrive_Colab_Mirror.ipynb # Notebook migrasi Colab Multi-Threaded
├── scripts/
│   └── mirror.py             # Script mirror engine
├── .env.example              # Template environment variables
└── README.md                 # Dokumentasi proyek
```

---

## 🔐 Keamanan & Privasi

- Seluruh kredensial dan token API **hanya disimpan dalam Environment Variables / Secrets** dan tidak pernah di-hardcode di dalam repositori publik.
- File `.env` dan `.env.deploy` otomatis diabaikan oleh `.gitignore`.
- Rute Admin (`/admin` dan API modifikasi) diproteksi menggunakan cookie sesi terenkripsi dan PIN keamanan.

---

## 📄 Lisensi
Proyek ini dilisensikan di bawah lisensi MIT. Bebas digunakan dan dimodifikasi untuk kebutuhan personal maupun komunitas.
