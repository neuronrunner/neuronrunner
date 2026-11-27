---
title: Ortamlar (Environments)
description: Kurulum scriptleri, ortama özel şifreli gizli anahtarlar ve otomatik bağımlılık önbelleği ile sınırsız repo tabanlı ortamlar.
---

**Ortamlar (Environments)**, Git repolarınızı tekrarlanabilir çalışma yapılandırmalarına bağlar: kurulum ve bakım scriptleri, ortama özel şifreli gizli anahtarlar ve ajana özel talimatlar bir aradadır.

## Ortam oluşturma

Her çalışma alanında sol menüden (`Ortamlar → +`) veya sohbet çubuğundan **sınırsız ortam** oluşturabilirsiniz:

1. **GitHub Repo (önerilen):** Bağlı GitHub reponuzu seçin (veya URL / `owner/repo` girin) ve varsayılan dalı belirleyin. Ortam anında kaydedilir; repo ilk görevinizde veya **Kurulumu çalıştır** dediğinizde otomatik klonlanır.
2. **Yeni Klasör / Mevcut Klasör:** `/workspace` altında yeni bir Git klasörü oluşturun veya mevcut bir klasörü ortama ekleyin.

İsteğe bağlı olarak **Kurulum scriptleri, gizli anahtarlar ve talimatlar** bölümünü açıp şunları tanımlayabilirsiniz:

- **Hızlı şablonlar:** `Node / npm`, `pnpm`, `Python / uv`, `Go` ve `Rust` için tek tıkla hazır komutlar.
- **Kurulum scripti:** Ortam ilk kez açıldığında veya lockfile değiştiğinde otomatik çalışır (örn. `npm ci`, `uv sync`).
- **Bakım scripti:** Bir sohbet izole bir Git dalı (worktree) açtığında otomatik çalışır.
- **Çalışma alt klasörü:** Monorepo projeleri için opsiyonel alt dizin (örn. `apps/web`).
- **Ortam gizli anahtarları (`.env`):** Şifreli saklanır ve yalnızca bu ortamdaki ajan çalıştırmalarına enjekte edilir. Aynı anahtar adına sahip çalışma alanı secret'larını ezer.
- **Ajan talimatları:** Repo kuralları, test komutları veya ajan için özel notlar.

## Çalışmaların saklanması ve bağımlılık önbelleği

- **Devam eden çalışmalar:** Kaydedilmemiş değişiklikleriniz, yeni oluşturduğunuz kaynak dosyaları ve push edilmemiş commit'leriniz oturumlar arasında otomatik olarak korunur.
- **Bağımlılık önbelleği:** Kurulan bağımlılıklar (örneğin `node_modules` veya Python sanal ortamları) lockfile'a göre önbelleğe alınır, böylece sonraki oturumlar daha hızlı başlar. 7 gün kullanılmayan önbellekler otomatik temizlenir; isterseniz **Ortam Ayarları → Scriptler & Önbellek → Önbelleği temizle** ile istediğiniz zaman manuel temizleyebilirsiniz.

> [!TIP]
> Ana doğruluk kaynağı olarak her zaman Git'i kullanın ve dallarınızı düzenli push'layın. Büyük veri setlerini, medya dosyalarını veya model ağırlıklarını çalışma klasöründe tutmak yerine harici depolamada (S3, R2 veya Hugging Face gibi) saklayın ve yerel yollarını `.gitignore`'a ekleyin.

## Ortam ayarları

Herhangi bir ortamın yanındaki ayarlar simgesinden şunları yönetebilirsiniz:

- **Genel:** Ad, açıklama, repo URL'si, varsayılan dal, çalışma alt klasörü ve ajan talimatları.
- **Scriptler & Önbellek:** Kurulum/bakım scriptleri, anlık durum (`Beklemede` / `Çalışıyor` / `Hazır` / `Hatalı`), son kurulum günlüğü, **Kurulumu çalıştır** ve **Önbelleği temizle**.
- **Gizli Anahtarlar:** Ortama özel şifreli gizli anahtarlar (tek anahtar veya toplu `.env` yapıştırma) ve çalışma alanından devralınan anahtarların salt-okunur özeti.
