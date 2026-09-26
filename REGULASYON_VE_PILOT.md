# SonPorsiyon — pilot ve güvenlik sınırları

Bu belge hukuki görüş değildir. SonPorsiyon'un gerçek bir pilot öncesinde uzman incelemesine hazırlanması için operasyonel risk çerçevesidir.

## Ürün sınırları

- Yalnız kamusal unvan, adres ve kayıt/onay bilgisi platform tarafından eşleştirilmiş işletme, kampüs/yurt veya kurumsal yemekhane sağlayıcı olabilir.
- Cüzdan imzası işletme statüsünü kanıtlamaz. Kayıt bilgisi eşleştirilen işletmenin açık cüzdan adresi backend ve kontrat izin listesine birlikte eklenmeden yayınlama yetkisi verilmez.
- Bu, SonPorsiyon'un offchain sağlayıcı kabul kontrolüdür; Bakanlık entegrasyonu, Bakanlık adına doğrulama veya resmî sertifikasyon olarak sunulmaz. Bakanlık logosu kullanılmaz.
- Başvuruda TCKN, VKN ve belge/karekod görüntüsü toplanmaz. Yalnız karekod sorgusunda zaten görünen işletme unvanı, adresi ve kayıt/onay numarası eşleştirilir.
- Ev yapımı ürün, açık büfe artığı, son tüketim tarihi geçmiş ürün ve kaynağı belirsiz ürün alınmaz.
- İlk pilot yalnız aynı gün hazırlanmış, kapalı paketli ve düşük riskli ürünlerle yapılır: ekmek, poğaça, paketli sandviç ve bütün meyve.
- Soğuk zincir, sıcak yemek, çiğ et/balık, krema ve yüksek riskli süt/et ürünleri ilk pilot dışındadır.
- Hazırlanma zamanı, saklama biçimi, son güvenli teslim zamanı ve alerjen bilgisi zorunludur.
- Süre dolduğunda claim ve teslim kodu kapanır; blockchain kaydı gıda güvenliğine üstün gelemez.
- Kullanıcıya “gıda güvenliği zincirle doğrulandı” veya “fiziksel teslim kanıtlandı” denmez.

## Sorumluluk haritası

| Risk | MVP sahibi | Zincirin kanıtladığı |
|---|---|---|
| Ürünün güvenliği, saklama ve alerjen beyanı | Kayıtlı sağlayıcı | Kanıtlamaz; yalnız beyanın hash/event izini tutar |
| Sağlayıcı kimliği ve askıya alma | Platform operasyonu | Allowlist değişikliğini gösterebilir |
| Bir porsiyonun iki kişiye ayrılmaması | Protokol | Slot state geçişini kanıtlar |
| Fiziksel teslimin gerçekten gerçekleşmesi | Sağlayıcı + operasyon denetimi | Yalnız kodun sağlayıcı tarafından kapatıldığını gösterir |
| Kişisel veri aydınlatması/saklama süresi | Platform veri sorumlusu | PII zincire yazılmaz; offchain süreç yine KVKK kapsamındadır |

## Resmî dayanaklardan çıkan ürün kararları

1. Tarım ve Orman Bakanlığının 28 Temmuz 2025'ten beri zorunlu tuttuğu işletme karekodu; unvan, adres, kayıt/onay numarası ve son denetim tarihini tüketiciye gösteriyor. Pilot onboarding'inde bu kamuya açık bilgilerin eşleştirilmesi P0'dır; SonPorsiyon resmî doğrulayıcı rolü üstlenmez.
2. Türk Gıda Kodeksi kapsamında toplu tüketim yerlerinde 14 alerjene ilişkin bilginin son tüketiciye sunulması zorunludur. Serbest metin yerine üretimde standart alerjen seçimi kullanılmalıdır.
3. KVKK'nın temel ilkeleri amaçla bağlantılı, sınırlı ve ölçülü veri işlemeyi ve gerekli süre kadar saklamayı gerektirir. Kullanıcının kesin konumu sunucuya gönderilmez veya saklanmaz; yalnız cihazda anlık mesafe hesabında kullanılır. Kamusal işletme adresi ve teslim noktası koordinatı paketin bulunabilmesi için saklanır. Telefon, gelir/yardım durumu ve zincirde kalıcı kişi profili MVP için gereksizdir.
4. Gıda bankacılığı vergi indirimi, ilgili mevzuattaki şartlarla gıda bankacılığı faaliyeti yürüten dernek/vakıflara yapılan bağışlara bağlıdır. SonPorsiyon doğrudan tüketici rezervasyonunu otomatik olarak bu statüde göstermemeli veya vergi faydası vaat etmemelidir.

## Pilot öncesi gereklilikler

- İşletme kayıt/onay belgesi ve fiziksel teslim noktası kontrolü
- Ürün kategorisi, 14 alerjen seçimi, hazırlama/saklama ve güvenli teslim zamanı
- Şikâyet, olay kaydı, toplatma/kapatma ve sağlayıcı askıya alma akışı
- Kullanıcı ve sağlayıcı için aydınlatma metni; offchain saklama/imha süresi
- Sorumluluk ve kullanım koşullarının gıda hukuku uzmanıyla kontrolü
- En az bir sağlayıcı çalışanıyla 10 gerçek paketlik kapalı pilot

## Pilot başarı ve durdurma ölçütleri

**Başarı ölçütü:** 10 paketin en az 7'si süresinde alınır; gelinmeyen paketler süre bitince yeniden açılır; hiçbir gıda güvenliği şikâyeti olmaz; sağlayıcı ikinci kez yayınlamak ister.

**Durdurma ölçütü:** sağlayıcı kayıt durumu doğrulanamaz; ürün bilgisi eksik girilir; teslimler son güvenli saatten sonra kapatılabilir; çalışan akışı manuel mesajlaşmadan daha zahmetlidir veya “kurtarılan” sayacı fiziksel kanıt gibi sunulur.

## Kaynaklar

- [Tarım ve Orman Bakanlığı — Kayıt / Onay](https://www.tarimorman.gov.tr/Konular/Gida-Ve-Yem-Hizmetleri/Gida-Hizmetleri/Kayit-Onay?Ziyaretci=Tuketici)
- [Tarım ve Orman Bakanlığı — Gıda işletmelerinde karekod uygulaması](https://www.tarimorman.gov.tr/Konu/2252/)
- [Tarım ve Orman Bakanlığı — Türk Gıda Kodeksi ve alerjen bilgisi](https://www.tarimorman.gov.tr/Konular/Gida-Ve-Yem-Hizmetleri/Gida-Hizmetleri/Kodeks?Ziyaretci=Tuketici)
- [Ticaret Bakanlığı — gıda ürünleri mevzuat listesi](https://urunkurallari.ticaret.gov.tr/tr/sektorel-rehber/gida-urunleri/mevzuat)
- [KVKK — kişisel verilerin işlenmesine ilişkin temel ilkeler](https://www.kvkk.gov.tr/Icerik/4189/Kisisel-Verilerin-Islenmesine-Iliskin-Temel-Ilkeler)
- [GİB — 2026 Hazır Beyan Rehberi, gıda bankacılığı](https://intvrg.gib.gov.tr/hazirbeyan/assets/pdf/2026hbskilavuz.pdf)
