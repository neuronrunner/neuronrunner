---
title: Ortamlar (Environments)
description: Kurulum scriptleri, ortama özel şifreli gizli anahtarlar ve otomatik durum/bağımlılık önbelleği ile sınırsız repo tabanlı ortamlar.
---

**Ortamlar (Environments)**, Git repolarınızı tekrarlanabilir bulut çalışma yapılandırmalarına bağlar: kurulum/bakım scriptleri, ortama özel şifreli gizli anahtarlar ve yüksek hızlı yerel NVMe yürütme bir aradadır.

## Ortam oluşturma

Her çalışma alanında sol menüden (`Ortamlar → +`) veya sohbet çubuğundan **sınırsız ortam** oluşturabilirsiniz:

1. **GitHub Repo (önerilen):** Bağlı GitHub reponuzu seçin (veya URL / `owner/repo` girin) ve varsayılan dalı belirleyin. Ortam makineyi uyandırmadan anında kaydedilir; repo ilk görevinizde veya **Kurulumu çalıştır** dediğinizde otomatik klonlanır.
2. **Yeni Klasör / Mevcut Klasör:** `/workspace` altında yeni bir Git klasörü oluşturun veya mevcut bir klasörü ortama ekleyin.

İsteğe bağlı olarak **Kurulum scriptleri, gizli anahtarlar ve talimatlar** bölümünü açıp şunları tanımlayabilirsiniz:

- **Hızlı şablonlar:** `Node / npm`, `pnpm`, `Python / uv`, `Go` ve `Rust` için tek tıkla hazır komutlar.
- **Kurulum scripti (`setup_script`):** Ortam ilk kez açıldığında veya lockfile değiştiğinde bir kez çalışır (örn. `npm ci`, `uv sync`).
- **Bakım scripti (`maintenance_script`):** Bir sohbet izole bir Git dalı (worktree) açtığında otomatik çalışır.
- **Çalışma alt klasörü (`working_subdir`):** Monorepo projeleri için opsiyonel alt dizin (örn. `apps/web`).
- **Ortam gizli anahtarları (`.env`):** Şifreli saklanır ve yalnızca bu ortamdaki ajan çalıştırmalarına enjekte edilir. Aynı anahtar adına sahip çalışma alanı secret'larını ezer.
- **Ajan talimatları:** Repo kuralları, test komutları veya ajan için özel notlar.

## Durum ve bağımlılık önbelleği nasıl çalışır?

Her ortam doğrudan container'ın **hızlı yerel geçici (ephemeral) NVMe diskinde** (`/workspace/<slug>`) çalışır. Arka planda iki hafif kalıcılık katmanı devrededir:

1. **Sıkıştırılmış durum kaydı (`state/<env>.tar.zst`):**
   - Push edilmemiş commit'leri (git bundle), kaydedilmemiş diff'leri ve untracked kaynak dosyalarını her ajan turu sonunda ve container kapanırken otomatik olarak arşivler.
   - Ağır türetilmiş klasörler (`node_modules`, `.venv`, `venv`, `vendor`, `.next`, `dist`, `build`, `target`, `__pycache__`) `.gitignore` içinde olmasa bile otomatik hariç tutulur.
   - Yeni bir container açıldığında repo klonlanır ve kaydedilen durumunuz otomatik olarak geri yüklenir.
2. **Hibrit bağımlılık önbelleği (`deps/` & `deps-dir/`):**
   - Lockfile özetine (`package-lock.json`, `pnpm-lock.yaml`, `yarn.lock`, `bun.lock`, `uv.lock`, `poetry.lock`, `requirements.txt`, `pyproject.toml`, `go.sum`, `Cargo.lock`) göre anahtarlanır.
   - **≤ 300 MB:** `zstd` arşivi olarak saklanır ve ~1 saniyede yerel NVMe'ye açılır.
   - **> 300 MB:** Açık dizin olarak saklanıp ortama symlink ile bağlanır (<0.2 sn açılış).
   - **7 gün TTL:** 7 gün dokunulmayan bağımlılık önbellekleri otomatik silinir. İsterseniz **Ortam Ayarları → Scriptler & Önbellek → Önbelleği temizle** ile manuel temizleyebilirsiniz.

## Depolama ve durum üst sınırları

Container kapanışlarının kilitlenmesini önlemek ve yanlışlıkla indirilen dev veri setleri veya model ağırlıklarının depolamayı şişirmesini engellemek için aşağıdaki sert sınırlar uygulanır:

| Katman | Üst Sınır | Sınır aşıldığında ne olur? |
| --- | --- | --- |
| **Tekil untracked / non-git dosya** | **50 MB** | `state.tar.zst` arşivine alınmaz (`skipped_large_files` olarak atlanır); tüm kaynak kod, git diff ve push edilmemiş commit'ler normal şekilde kaydedilmeye devam eder. |
| **Toplam kaydedilmemiş durum (`state`)** | Ortam başına **1 GB** | Arşivleme güvenle durdurulur (`state_too_large`). Değişikliklerinizi commit & push yapın veya büyük dosyaları `.gitignore`'a ekleyin. |
| **Türetilmiş bağımlılık önbelleği (`deps`)** | Ortam başına **5 GB** | Bağımlılıklar aktif oturumda yerel NVMe'de çalışmaya devam eder, kalıcı depoya kopyalanmaz; kullanılmayan önbellekler **7 gün** sonra silinir. |

> [!TIP]
> Ana doğruluk kaynağı olarak her zaman Git'i kullanın ve dallarınızı düzenli push'layın. Büyük veri setlerini, medya dosyalarını veya model ağırlıklarını harici nesne depolamada (S3 / R2 / Hugging Face) tutup yerel yollarını `.gitignore`'a ekleyin.

## Ortam ayarları

Herhangi bir ortamın yanındaki ayarlar simgesinden şunları yönetebilirsiniz:

- **Genel:** Ad, açıklama, repo URL'si, varsayılan dal, çalışma alt klasörü ve ajan talimatları.
- **Scriptler & Önbellek:** Kurulum/bakım scriptleri, anlık durum (`Beklemede` / `Çalışıyor` / `Hazır` / `Hatalı`), son kurulum günlüğü, **Kurulumu çalıştır** ve **Önbelleği temizle**.
- **Gizli Anahtarlar:** Ortama özel şifreli gizli anahtarlar (tek anahtar veya toplu `.env` yapıştırma) ve çalışma alanından devralınan anahtarların salt-okunur özeti.
