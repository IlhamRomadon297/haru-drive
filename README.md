# 🌸 HaruDrive

[![Cloudflare Workers](https://img.shields.io/badge/Cloudflare-Workers-F38020?style=for-the-badge&logo=cloudflare&logoColor=white)](https://workers.cloudflare.com/)
[![Hugging Face](https://img.shields.io/badge/Hugging%20Face-Storage-FFD21E?style=for-the-badge&logo=huggingface&logoColor=black)](https://huggingface.co/)
[![License](https://img.shields.io/badge/License-MIT-blue.svg?style=for-the-badge)](LICENSE)

**HaruDrive** is a lightning-fast, modern cloud storage index and streaming platform powered by **Hugging Face Hub (Git LFS)** storage and **Cloudflare Workers**. Built with sleek glassmorphism aesthetics, dark mode support, deep-linking for external media players (PotPlayer, VLC, MX Player, IINA), and automated **Cloud-to-Cloud Google Drive Mirroring**.

---

## ✨ Features

- 📦 **Massive Hugging Face Storage:** Uses Hugging Face Datasets as a permanent, high-speed backend storage (supporting up to 8TB+ per account across datasets).
- ⚡ **HTTP Range & Seeking:** Full `206 Partial Content` streaming support for smooth, bufferless seeking in external players.
- 🎬 **Built-in & Deep-Link Video Player:**
  - **In-Browser:** HTML5 Video Player modal with instant playback.
  - **Desktop:** PotPlayer, VLC Desktop, IINA (macOS).
  - **Mobile:** MX Player, MX Player Pro, VLC Android, VLC iOS.
- 🚀 **Cloud-to-Cloud Mirror (0% Local Bandwidth):**
  - **GitHub Actions Cloud Runner:** Trigger 1-click Google Drive to Hugging Face mirroring directly from the web admin.
  - **Google Colab Unlimited Runner:** 1-Click notebook backup when GitHub Actions minutes are low.
- 🔐 **Password Authorization:** Clean session-based authentication to protect your index and admin controls.
- 🎨 **Modern Aesthetics:** Tailored dark/light mode with glassmorphism, gradient accents, and responsive layout.
- 📋 **Bulk Selection:** Multi-select files to copy streaming links or trigger sequential downloads.

---

## 🚀 Quick Setup & Deployment

### 1. Prerequisites
- Node.js & npm installed.
- Cloudflare Account logged in with Wrangler (`npx wrangler login`).
- Hugging Face Account with a **Dataset** repository created (e.g. `your-username/harudrive-storage`).
- Hugging Face **User Access Token** with `Write` permission ([Generate Token](https://huggingface.co/settings/tokens)).

### 2. Set Up Secrets on Cloudflare
```bash
npx wrangler secret put HF_REPO_ID
# Enter: your-username/harudrive-storage

npx wrangler secret put HF_TOKEN
# Enter: hf_... (Your Hugging Face Token)

npx wrangler secret put APP_PASSWORD
# Enter: Your desired password

npx wrangler secret put GITHUB_REPO
# Enter: IlhamRomadon297/haru-drive

npx wrangler secret put GITHUB_PAT
# Enter: ghp_... (GitHub Token with repo scope)
```

### 3. Deploy to Cloudflare Workers
```bash
npx wrangler deploy
```

---

## 🚀 Cloud-to-Cloud Mirroring Guide

### Method A: Web UI Trigger (GitHub Actions)
1. Open your deployed HaruDrive website and log in.
2. Click **🚀 Cloud Mirror** in the top navigation.
3. Paste any public Google Drive Folder/File link and target folder name.
4. Click **Start Cloud Mirror**. GitHub Actions will download and upload in the cloud with gigabit speed!

### Method B: Google Colab Runner (Unlimited Backup)
1. Open [`tools/HaruDrive_Colab_Mirror.ipynb`](tools/HaruDrive_Colab_Mirror.ipynb) in [Google Colab](https://colab.research.google.com/).
2. Fill in the form fields (`GDRIVE_URL`, `HF_TOKEN`, `HF_REPO_ID`, `TARGET_PATH`).
3. Click Run Cell!

---

## ⚙️ Environment Variables Reference

| Variable | Description |
| :--- | :--- |
| `HF_REPO_ID` | Hugging Face Dataset repo path (e.g. `username/repo`) |
| `HF_TOKEN` | Hugging Face Access Token with Write access |
| `APP_PASSWORD` | Password required to access HaruDrive |
| `GITHUB_REPO` | GitHub Repository for Action Dispatch (`IlhamRomadon297/haru-drive`) |
| `GITHUB_PAT` | GitHub Personal Access Token to trigger Actions |

---

## 📜 License
Distributed under the MIT License.
