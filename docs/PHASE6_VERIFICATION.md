# PHASE 6 VERIFICATION REPORT

Tanggal: **9 Oktober 2026**. Scope: **Vector Layer Styling & Advanced Layer Management**. Phase 1–4 dipertahankan; Phase 5 raster sengaja ditunda, object storage tidak ditambahkan, dan Phase 7 belum dimulai.

## Hasil fitur

PASS di bawah didasarkan pada pemeriksaan unit, PostgreSQL/PostGIS dan runtime browser nyata yang dijalankan, bukan hanya keberhasilan build. Fixture pengujian hanya berada pada database/storage terisolasi dan tidak menjadi data contoh aplikasi.

| Feature | Result |
| --- | --- |
| Polygon Styling | PASS |
| Line Styling | PASS |
| Point Styling | PASS |
| Live Preview | PASS |
| Style Persistence | PASS |
| Categorized Styling | PASS |
| Dynamic Legend | PASS |
| Layer Ordering | PASS |
| Layer Grouping | PASS |
| Vector Labeling | PASS |
| Zoom Visibility | PASS |
| Zoom to Layer | PASS |
| Layer Search | PASS |
| Admin Authorization | PASS |
| Viewer Read Only | PASS |
| Existing SHP Upload | PASS |
| No Demo Data | PASS |
| Lint | PASS |
| Type Check | PASS |
| Automated Tests | PASS |
| Production Build | PASS |
| Runtime Testing | PASS |

## Pemeriksaan yang dijalankan

| Pemeriksaan | Bukti hasil |
| --- | --- |
| `npm run lint` | Lulus. |
| `npm run typecheck` | Lulus, termasuk generation tipe Next.js. |
| `npm test` | 172 unit test lulus. |
| `npm run build` | Production build lulus. |
| `npm run test:integration` | 159 integration test lulus; termasuk 21 pengujian Phase 6 dengan PostgreSQL/PostGIS nyata. |
| `npm run db:migrate` dua kali | Lulus; penerapan ulang memakai jurnal migration tanpa mengulang perubahan yang sudah diterapkan. |
| `npx drizzle-kit check` | Pemeriksaan migration lulus. |
| `npm run test:styling` | Lulus; tiga kelompok verifikasi styling dan alur upload/styling/delete dalam harness browser. |
| `npm run test:gis` | Regresi GIS/User Management browser lulus. |
| `npm run test:vector` | Regresi alur upload/import/render/popup/edit/delete Phase 4 lulus. |

Suite styling memakai ulang `scripts/test-vector-browser.mjs --styling`, production web build, worker GDAL, PostgreSQL/PostGIS dan Chromium. Database, source ZIP serta storage fixture dibuat khusus pengujian. Sesi akun uji dibuat di database sementara; aplikasi tidak diberi bypass login production.

Bukti runtime mencakup perubahan piksel fill/outline/opacity polygon tanpa fetch geometry ulang, preview/save/refresh/cancel/reset, warna kategori dan legenda, label menggunakan glyph lokal serta rentang zoom. Layer line dan point benar-benar diunggah melalui pipeline Phase 4; warna, garis putus-putus, radius/stroke, persistensi, layout mobile dan penghapusan worker diuji.

Pengujian berikutnya memeriksa urutan sublayer MapLibre yang sebenarnya, grup/rename, default visibility versus override lokal setelah refresh, pencarian/fit extent, page/API untuk semua role/status, CSRF, pencabutan role saat sesi masih aktif, dan geometry yang tidak berubah. Integration juga meng-upgrade database Phase 4 yang berisi layer/style/geometry/akun/sesi untuk membuktikan migration mempertahankan data tersebut.

## Implementasi dan file

Editor baru berada di `/admin/layers/[id]/style`, dapat dibuka melalui **Administration → Layers → Edit Style**. Single Symbol dan Categorized memakai layer yang sudah diunggah; perubahan draft langsung terlihat pada preview, Save menyimpan database, Cancel memulihkan style tersimpan, dan Reset hanya mengganti draft sampai Save dipilih. Petunjuk pengguna lengkap tersedia di [README Phase 6](../README.md#phase-6--vector-styling-dan-pengelolaan-layer).

| File ditambahkan | Tanggung jawab |
| --- | --- |
| `src/lib/gis/style.ts`, `src/lib/gis/map-style.ts` | Schema style version 1, fallback legacy, expression aman, validasi bbox dan sinkronisasi MapLibre. |
| `src/server/layers/styling.ts` | Pembacaan atribut, simpan style/settings, urutan/grup, transaksi dan audit. |
| `src/app/admin/layers/[id]/style/page.tsx` | Halaman editor yang dilindungi server. |
| `src/app/api/admin/layers/[id]/{style,attributes,settings}/route.ts`, `src/app/api/admin/layers/{order,groups}/route.ts` | API styling dan pengelolaan layer tambahan. |
| `src/components/admin/style-editor.tsx`, `style-editor.module.css`, `layer-manager.module.css` | Form editor/preview dan penyajian pengelolaan layer. |
| `src/components/layers/layer-symbol.tsx`, `visibility-state.ts`, `layer-panel.module.css` | Simbol dinamis, preferensi lokal dan panel grup/pencarian. |
| `migrations/0006_vector_styling_management.sql`, `migrations/meta/0006_snapshot.json` | Metadata layer dan snapshot migration incremental. |
| `tests/vector-style.test.ts`, `tests/map-style.test.ts`, `tests/layer-visibility.test.ts`, `tests/integration/vector-styling.test.ts` | Validasi, rendering, preferensi, keamanan dan persistensi/migration. |
| `scripts/verify-vector-styling.mjs` | Verifikasi browser styling dengan fixture upload terisolasi. |

File existing yang diperbarui mencakup schema database/jurnal migration, DTO dan katalog layer, layer manager, layer/legend panel, GISViewer/MapCanvas, halaman `/map`, helper admin/error, runner browser vector, regression test, `package.json`, README dan PLAN. Upload, worker GDAL dan deletion service Phase 4 dipakai ulang. Tidak ada tabel layer kedua atau GIS Viewer baru.

## Database, schema dan MapLibre

Migration `0006` menambahkan `default_visible`, `group_name`, `sort_order`, index urutan serta constraint pada `app.layers`. Urutan awal mengikuti `created_at, id`; default visibility disalin dari publication yang sudah ada. Style JSON, geometry, upload, user dan authentication tidak dihapus atau direset. Normalisasi baca mempertahankan property legacy yang aman dan menyediakan fallback untuk style kosong/tidak valid; JSON version 1 ditulis saat Save eksplisit.

Style memiliki `version`, keluarga `type`, `mode`, `color/opacity`, `width/radius`, `strokeColor/strokeWidth/strokeOpacity`, `dash`, `category`, `label`, `minZoom/maxZoom`. Polygon mengatur fill dan outline secara terpisah; line memakai warna/lebar/opacity/dash; point memakai circle/radius/stroke. Geometry Multi memakai keluarga style yang sama. Kategori menggunakan field/nilai scalar nyata dengan warna fallback. JSON lengkap dan semua batas property didokumentasikan di [README](../README.md#format-style-dan-mekanisme-maplibre).

Style diterapkan pada instance/source MapLibre yang sudah ada melalui `setPaintProperty`, `setLayoutProperty`, `setLayerZoomRange` dan `moveLayer`. Perubahan warna tidak membuat ulang map atau seluruh sumber geometry. Sublayer fill/outline/label bergerak bersama; item paling atas katalog digambar paling atas. Legend memakai style aktif dan urutan yang sama.

Label memakai symbol/collision MapLibre dengan teks maksimal 120 karakter dan glyph lokal font `sans-serif`, tanpa elemen HTML per fitur atau layanan glyph eksternal. Rentang zoom label merupakan irisan rentang layer/label; maksimum eksklusif. Zoom to Layer memakai bbox tervalidasi. Grup tidak mengganti urutan global.

Publication (`is_visible`), default checkbox (`default_visible`) dan override lokal merupakan tiga hal berbeda. VIEWER tidak memperoleh layer unpublished dari server. Override checkbox tersimpan di sessionStorage per akun/tab dan tidak menulis database; **Use default visibility** menghapus override. Katalog diperbarui berkala sekitar 30 detik saat tab terlihat.

## API dan keamanan

| Endpoint | Operasi |
| --- | --- |
| `GET /api/admin/layers/:id/style` | Style detail dan token CSRF. |
| `PUT /api/admin/layers/:id/style` | Simpan `{style}`. |
| `GET /api/admin/layers/:id/attributes` | Field yang boleh ditampilkan beserta flag sampling. |
| `GET /api/admin/layers/:id/attributes?field=...` | Nilai kategori, flag sampling dan truncation. |
| `POST /api/admin/layers/order` | Move up/down berdasarkan layer ID. |
| `PATCH /api/admin/layers/:id/settings` | Grup dan default visibility. |
| `PATCH /api/admin/layers/groups` | Rename/merge grup. |

Seluruh endpoint tersebut, termasuk GET, memerlukan APPROVED ADMIN. Mutasi memeriksa Origin dan token CSRF terikat sesi, kemudian memeriksa ulang hak actor dan identitas Google dalam transaksi. Audit memakai `LAYER_UPDATED` yang sudah ada. VIEWER/PENDING/REJECTED dan sesi tidak sah ditolak server; menyembunyikan tombol bukan satu-satunya pengamanan.

Validasi ketat mencakup UUID, kecocokan keluarga geometry, hex color, finite numeric ranges, zoom, label field, kategori dan group/order. Property tambahan serta expression bebas ditolak. Field/nilai kategori diperiksa terhadap tabel PostGIS terdaftar; field JSONB memakai parameter, bukan raw identifier client. Table name internal/credential/error database tidak dikirim ke browser. Picker dibatasi 10000 fitur, 100 field, 50 kategori dan timeout 3 detik per statement SQL, termasuk waktu tunggu lock statement tersebut. Durasi total transaksi dapat lebih panjang karena terdiri dari beberapa statement. Hasil terbatas dijelaskan pada UI. Geometry delivery dan batas MVT Phase 4 dipertahankan.

## Belum diverifikasi dan pengujian pengguna

| Area | Status / tindak lanjut |
| --- | --- |
| Consent dan callback Google OAuth nyata pada lingkungan pengguna | **NOT VERIFIED** pada pengujian ini; browser otomatis memakai sesi database terisolasi. Uji login dengan OAuth client dan origin yang digunakan pengguna. |
| Shapefile dan atribut perusahaan | **NOT VERIFIED**; coba polygon/line/point asli, Unicode, field kategori/label, bbox dan CRS perusahaan. |
| Beban maksimum dan akses banyak pengguna bersamaan di produksi | **NOT VERIFIED**; batas resource tidak merupakan jaminan kapasitas hardware/deployment. |
| Deployment produksi serta restart/restore layanan pada infrastruktur tujuan | **NOT VERIFIED**; pengujian dilakukan dalam lingkungan development/test terisolasi. |

Uji manual: login admin, edit style tiap keluarga geometry, periksa preview lalu Save/refresh/logout-login; pilih kategori dan label nyata, sesuaikan zoom, urutan serta grup. Dengan akun VIEWER di profil berbeda, periksa legenda/popup dan bahwa checkbox pribadi tidak mengubah default global. Uji publication dan reset visibility, approval, upload baru, serta delete dengan konfirmasi pada data uji yang boleh dihapus. Restart server dengan database yang sama untuk memeriksa persistensi di lingkungan Anda.

Phase 6 selesai pada vector styling dan pengelolaan layer. Tidak ada graduated classification, geometry editing, pencarian fitur, raster, S3/MinIO atau Phase 7. Retensi ZIP sumber tetap mengikuti cleanup Phase 4.
