# Company GIS Portal — Phase 1 & GIS Viewer

Portal internal dengan login Google, persetujuan akun, dan akses berdasarkan role. Phase 1 mencakup Next.js + TypeScript, Tailwind CSS, PostgreSQL + PostGIS, Drizzle ORM/migration, Docker Compose, serta authentication dan authorization di server.

Phase 2 **GIS Viewer** kini tersedia di `/map` menggunakan MapLibre GL JS, vector tile PostGIS, panel layer/basemap/legenda, popup atribut, dan pengukuran. Sesuai permintaan lanjutan, `/admin` kini menyediakan **Account approvals** untuk menyetujui akun baru sebagai VIEWER melalui browser, serta **Approved accounts** untuk melihat akun yang telah disetujui dan status online/offline. Upload SHP/raster, worker GIS, serta antarmuka perubahan role dan penolakan akun belum dibuat. Cakupan fondasi mengikuti instruksi Phase 1 pengguna; penomoran awal di [PLAN.md](PLAN.md) memisahkan authentication menjadi fase tersendiri.

## Menjalankan development

Jalankan perintah dari folder repository. Dibutuhkan Node.js **24 LTS**, npm, Docker, dan Docker Compose v2. Codespaces menyediakan terminal Linux; perintah di bawah juga dapat digunakan pada Linux/macOS atau WSL.

1. Gunakan versi Node di `.nvmrc` bila `nvm` tersedia, lalu instal dependency sesuai lockfile:

   ```bash
   nvm install
   nvm use
   npm ci
   ```

   Jika tidak memakai `nvm`, pastikan `node --version` menunjukkan versi 24 sebelum menjalankan `npm ci`.

2. Buat `.env` **hanya jika belum ada**:

   ```bash
   cp -n .env.example .env
   ```

   Buka `.env` di editor dan isi tabel konfigurasi di bawah. `.env.example` hanyalah contoh. Jangan menimpa `.env` yang sudah berisi konfigurasi yang bekerja.

3. Jalankan database dan migration:

   ```bash
   docker compose up -d --wait db
   npm run db:migrate
   ```

4. Jalankan aplikasi dan biarkan terminal tetap aktif:

   ```bash
   npm run dev
   ```

5. Setelah muncul `Ready`, buka <http://localhost:3000/login>. Untuk Codespaces gunakan alamat port yang diteruskan seperti dijelaskan di bawah.

Database dan server development harus sama-sama berjalan. Setelah membuka kembali Codespaces, jalankan langkah 3–4 lagi. Migration mencatat versi yang sudah diterapkan, sehingga boleh dijalankan kembali.

## Konfigurasi `.env`

Buat nilai acak berbeda untuk `POSTGRES_PASSWORD`, `APP_DB_PASSWORD`, dan `AUTH_SECRET`. Jalankan perintah berikut **tiga kali**, lalu simpan setiap hasil ke variabel yang sesuai di `.env`:

```bash
node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"
```

| Variabel | Isi / fungsi |
| --- | --- |
| `POSTGRES_DB` | `company_gis`, nama database development. |
| `POSTGRES_USER` | `gis_owner`, pemilik database untuk bootstrap dan migration. |
| `POSTGRES_PASSWORD` | Password acak milik `gis_owner`. |
| `APP_DB_PASSWORD` | Password acak lain untuk role runtime `gis_app`. |
| `POSTGRES_PORT` | `5432`; port database di host, terikat ke `127.0.0.1`. |
| `APP_PORT` | `3000`; port aplikasi ketika memakai Compose. |
| `DATABASE_URL` | `postgresql://gis_app:REPLACE_APP_PASSWORD@localhost:5432/company_gis` — ganti placeholder dengan `APP_DB_PASSWORD`. |
| `MIGRATION_DATABASE_URL` | `postgresql://gis_owner:REPLACE_OWNER_PASSWORD@localhost:5432/company_gis` — ganti placeholder dengan `POSTGRES_PASSWORD`. |
| `GOOGLE_CLIENT_ID` | Client ID dari OAuth client bertipe **Web application**. |
| `GOOGLE_CLIENT_SECRET` | Client secret dari OAuth client yang sama. |
| `AUTH_SECRET` | Nilai acak minimal 32 karakter untuk Auth.js. |
| `AUTH_URL` | Origin aplikasi, misalnya `http://localhost:3000`; untuk Codespaces gunakan origin HTTPS port 3000. Tanpa `/login`, query, atau fragment. |
| `SUPER_ADMIN_EMAILS` | Email Google admin awal, dipisahkan koma jika lebih dari satu. Boleh kosong jika bootstrap tidak diperlukan. |

Sesuaikan kedua connection URL bila nama database atau port diubah. Password hex dari perintah di atas aman dipakai langsung dalam URL; password lain harus di-URL-encode. Compose membuat URL koneksi internalnya sendiri dengan hostname `db` dari variabel database; aplikasi yang dijalankan menggunakan `npm` memakai URL `localhost`.

`gis_app` mempunyai hak terhadap tabel akun dan sesi serta hanya `SELECT/INSERT` terhadap audit. `gis_owner` dipakai untuk migration, bukan runtime web. Migration mengaktifkan PostGIS serta membuat katalog layer dan tiga tabel data demo GIS dengan hak baca untuk runtime.

`.env` diabaikan Git dan Docker build. Simpan credential di konfigurasi privat; jangan memasukkannya ke screenshot, commit, atau README. Mengubah password dalam `.env` tidak otomatis mengubah password role pada volume PostgreSQL yang sudah dibuat; perubahan tersebut memerlukan rotasi password database yang sesuai.

## Google OAuth dan admin pertama

1. Buka [Google Cloud Console](https://console.cloud.google.com/), pilih project, lalu **Google Auth Platform**.
2. Lengkapi **Branding** dan **Audience**. Untuk akun Gmail biasa pilih **External**. Bila aplikasi dalam mode **Testing**, tambahkan akun Google yang akan dipakai pada **Audience → Test users**. **Internal** memerlukan organisasi Google Workspace yang sesuai.
3. Buka **Clients → Create client**, pilih **Web application**.
4. Untuk development lokal, isi:

   | Pengaturan | Nilai |
   | --- | --- |
   | Authorized JavaScript origins | `http://localhost:3000` |
   | Authorized redirect URIs | `http://localhost:3000/api/auth/callback/google` |

5. Salin Client ID dan Client secret ke `.env`. Isi `SUPER_ADMIN_EMAILS` dengan email Google yang Anda kendalikan untuk admin awal, lalu restart `npm run dev` setelah menyimpan perubahan.
6. Buka `/login`, pilih **Continue with Google**, dan selesaikan login. Akun dengan email admin tersebut akan mendapat `APPROVED + ADMIN` dan masuk ke `/map`. Buka **Administration** atau `/admin` untuk menguji akses admin.

Pencocokan `SUPER_ADMIN_EMAILS` menggunakan email Google terverifikasi, trim/lowercase, dan kecocokan penuh; tidak mendukung wildcard atau substring. Alamat yang masih terdaftar akan dipromosikan kembali **setiap login**. Setelah bootstrap, hapus alamat tersebut dari konfigurasi dan restart aplikasi jika keputusan demotion/rejection nantinya harus dipertahankan. Akun admin yang sudah dibuat tetap ada di database.

Tidak ada seed akun login, password default, ataupun bypass Google. Semua akun yang dipakai untuk uji manual harus login Google terlebih dahulu.

## Menggunakan GitHub Codespaces

Di panel **Ports**, teruskan port **3000**, lalu pilih **Open in Browser**. Alamatnya berbentuk:

```text
https://NAMA-CODESPACE-3000.app.github.dev
```

Gunakan nama Codespace Anda sendiri. Alamat editor yang berakhiran `.github.dev` berbeda dari alamat aplikasi yang berakhiran `-3000.app.github.dev`.

Atur `AUTH_URL` ke origin aplikasi tersebut. Pada OAuth client Google tambahkan origin yang sama dan redirect URI berikut:

```text
https://NAMA-CODESPACE-3000.app.github.dev/api/auth/callback/google
```

Restart `npm run dev`, buka `/login` melalui alamat aplikasi tersebut, lalu coba Google login. Bila membuat Codespace baru, perbarui `AUTH_URL` dan callback Google karena nama host berubah. Port PostgreSQL 5432 tidak perlu diteruskan ke browser.

Konfigurasi Next.js menyertakan pengecualian origin `localhost:3000` khusus `NODE_ENV=development` dan `CODESPACES=true` untuk permintaan Server Actions melalui proxy Codespaces. Pemeriksaan origin produksi tetap aktif. Untuk produksi, proxy harus meneruskan host/origin secara konsisten dengan origin HTTPS aplikasi.

## Alur akses dan pengujian manual

Google memverifikasi identitas, lalu aplikasi membaca akun dan sesi di PostgreSQL. Pengguna baru biasa dibuat sebagai `PENDING + VIEWER`. Session menggunakan database, dan guard server membaca status/role terbaru; mengganti UI atau mengetik URL `/admin` tidak memberikan akses admin.

| Keadaan akun | Tujuan setelah login | `/map` | `/admin` |
| --- | --- | --- | --- |
| Belum login / sesi kedaluwarsa | `/login` | Ke `/login` | Ke `/login` |
| `PENDING + VIEWER` | `/pending` | Ke `/pending` | Ke `/pending` |
| `REJECTED` | `/access-denied` | Ke `/access-denied` | Ke `/access-denied` |
| `APPROVED + VIEWER` | `/map` | Diizinkan | Ke `/access-denied` |
| `APPROVED + ADMIN` | `/map` | Diizinkan | Diizinkan |

Gunakan dua akun Google: akun admin pertama dan akun kedua untuk pengujian. Akun kedua jangan tercantum dalam `SUPER_ADMIN_EMAILS`. Login dengan akun kedua di profil browser berbeda atau setelah **Sign out**. Login pertama harus menampilkan `/pending` dan pesan **“Your account is waiting for administrator approval.”** Coba juga mengetik `/map` dan `/admin` langsung.

Untuk menyetujui akun kedua **tanpa terminal**:

1. Login dengan akun ADMIN, lalu buka **Administration → Account approvals**.
2. Klik **Refresh list** bila akun baru belum terlihat. Daftar menampilkan nama, email, dan tanggal pendaftaran, dengan 20 akun per halaman.
3. Periksa email akun, kemudian klik **Approve** pada barisnya. Tombol menampilkan **Approving…** selama permintaan berlangsung.
4. Setelah pesan berhasil muncul, akun tersebut keluar dari daftar pending dan mendapat `APPROVED + VIEWER`.
5. Pada browser akun kedua, klik **Check approval status** atau muat ulang halaman. `/map` harus terbuka; `/admin` tetap ditolak.

Persetujuan memerlukan sesi ADMIN yang masih aktif dan haknya diperiksa ulang di server saat transaksi. Identitas pemberi persetujuan berasal dari sesi, bukan form browser. Perubahan status dan audit disimpan bersama; klik ulang atau persetujuan bersamaan tidak menggandakan audit. Menu ini hanya menyetujui pengguna baru sebagai VIEWER, tanpa memberikan hak ADMIN. Schema dan migration yang ada sudah mendukung fitur ini.

CLI development tetap tersedia untuk pengujian perubahan role, penolakan, atau reset ke PENDING di **terminal kedua**. Ganti `penguji@example.com` dan `admin@example.com` di setiap perintah dengan email akun nyata yang sudah login Google. Jalankan hanya terhadap database development yang terisolasi. `--approved-by` harus menunjuk akun `APPROVED + ADMIN` yang sudah ada; akses terminal dan credential migration memberikan kewenangan untuk menjalankan perintah ini.

Alternatif CLI untuk menyetujui akun kedua sebagai VIEWER:

```bash
ALLOW_DEV_USER_COMMAND=true npm run db:user -- --email penguji@example.com --status APPROVED --role VIEWER --approved-by admin@example.com
```

Klik **Check approval status** atau muat ulang halaman akun kedua. `/map` harus terbuka; mengetik `/admin` langsung harus membawa akun tersebut ke `/access-denied`.

Promosikan akun kedua menjadi ADMIN:

```bash
ALLOW_DEV_USER_COMMAND=true npm run db:user -- --email penguji@example.com --status APPROVED --role ADMIN --approved-by admin@example.com
```

Muat ulang halaman akun kedua. `/map` dan `/admin` sekarang harus terbuka.

Uji penolakan:

```bash
ALLOW_DEV_USER_COMMAND=true npm run db:user -- --email penguji@example.com --status REJECTED --role VIEWER --approved-by admin@example.com
```

Penolakan menghapus sesi akun tersebut. Login Google kembali dengan akun kedua; aplikasi harus membuka `/access-denied` dan tetap menolak akses `/map` serta `/admin`.

Kembalikan akun kedua ke PENDING bila diperlukan:

```bash
ALLOW_DEV_USER_COMMAND=true npm run db:user -- --email penguji@example.com --status PENDING --role VIEWER --approved-by admin@example.com
```

CLI mencatat perubahan ke audit dan menolak penghapusan hak admin terakhir. CLI juga menolak demotion/rejection akun yang masih tercantum dalam `SUPER_ADMIN_EMAILS`. CLI tidak membuat user atau sesi baru dan dinonaktifkan ketika `NODE_ENV=production`.

Terakhir, uji **Sign out**, lalu buka `/map` dan `/admin`; keduanya harus kembali ke `/login`. Test otomatis tidak menggantikan uji consent/callback Google nyata dalam browser.

## Pemeriksaan dan migration

```bash
npm run lint
npm run typecheck
npm test
npm run build
```

Unit test mencakup kebijakan role/status, validasi identitas, adapter/config Auth.js, CLI development, dan pemeriksaan origin Codespaces. `typecheck` menjalankan generator tipe Next.js sebelum TypeScript.

Untuk integration test, nyalakan PostgreSQL/PostGIS dan pastikan `.env` berisi `MIGRATION_DATABASE_URL` milik owner serta `DATABASE_URL` milik `gis_app` pada server database yang sama. Owner memerlukan izin membuat database dan memasang extension PostGIS; `gis_owner` dari Compose memenuhi kebutuhan ini. Siapkan build terlebih dahulu:

```bash
npm run build
npm run test:integration
```

Runner membuat database sementara dengan nama unik, menerapkan migration dua kali, lalu menjalankan pengujian terhadap adapter/Auth.js dan akses halaman HTTP dengan server hasil build. Database sementara dibuang setelah selesai, termasuk saat test gagal; database aplikasi yang tercantum dalam `.env` tidak diubah. Jalankan suite ini hanya pada lingkungan development. Profil Google sintetis digunakan di dalam test untuk menguji lifecycle akun tanpa meminta credential Google nyata atau menambahkan jalur login khusus ke aplikasi.

Migration `0002_user_presence.sql` menambahkan tabel aktivitas tab dengan penghapusan otomatis saat sesi dihapus. Jalankan `npm run db:migrate` setelah menarik pembaruan ini.

Migration executable sebelumnya berada di `migrations/0000_identity.sql` dan `migrations/0001_postgis_runtime_permissions.sql`, beserta jurnal/snapshot Drizzle. Migration awal membuat tabel `app.users`, `app.accounts`, `app.sessions`, dan `app.audit_logs`; migration berikutnya menambahkan PostGIS, trigger `updated_at`, dan izin role runtime. `npm run db:migrate` menggunakan `MIGRATION_DATABASE_URL` dan lock agar migration paralel tidak saling bertabrakan.

Jika kelak mengubah schema, buat migration baru dengan `npm run db:generate`, periksa SQL yang dihasilkan, lalu terapkan melalui `npm run db:migrate`. Jangan mengubah migration yang sudah diterapkan. Tidak tersedia perintah down-migration otomatis; pemulihan memakai backup terverifikasi atau migration koreksi baru.

## Menjalankan seluruh aplikasi dengan Docker

Isi `.env` lebih dahulu, hentikan `npm run dev` agar port 3000 tersedia, kemudian jalankan:

```bash
docker compose up -d --build
docker compose ps
```

Compose memulai `db`, menjalankan service `migrate` setelah database sehat, lalu memulai `app` setelah migration berhasil. `migrate` yang selesai dengan exit code 0 adalah normal. Container app menggunakan build Next.js standalone dan user non-root. OAuth tetap membutuhkan konfigurasi Google dan `AUTH_URL` yang cocok dengan alamat browser.

Pada server deployment gunakan origin HTTPS dan reverse proxy tepercaya yang diarahkan ke port aplikasi lokal. Compose membatasi port app/database ke `127.0.0.1`; GitHub Pages tidak dapat menjalankan aplikasi ini karena membutuhkan server Node.js dan PostgreSQL. Tidak ada service worker GIS pada phase ini.

Data disimpan di named volume `postgres_data`. `docker compose stop` menghentikan service tanpa menghapusnya. Pembuatan ulang container mempertahankan volume; hindari `docker compose down -v` untuk database yang ingin disimpan.

Contoh backup database dari Compose:

```bash
docker compose exec -T db sh -c 'pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Fc' > ../company-gis-backup.dump
```

Simpan backup di tempat privat di luar repository karena memuat akun dan sesi. Uji restore ke database terpisah sebelum mengandalkannya untuk pemulihan; hentikan aplikasi saat melakukan pemulihan database yang dipakai aplikasi.

## Jika terjadi error

| Error/gejala | Langkah pemeriksaan |
| --- | --- |
| `ECONNREFUSED` / login `Configuration` disertai koneksi database ditolak | Jalankan `docker compose up -d --wait db`, lalu `npm run db:migrate`; pastikan port/host pada URL database benar. |
| Docker `RWLayer ... unexpectedly nil` | Jalankan `docker compose up -d --force-recreate --wait db` untuk membuat ulang container dengan volume yang sama, lalu migration dan `npm run dev`. |
| `password authentication failed` | Cocokkan password dalam URL dengan role pada database yang sudah diinisialisasi; mengedit `.env` saja tidak merotasi password database. |
| `relation ... does not exist` / izin schema | Jalankan migration dengan `MIGRATION_DATABASE_URL` milik `gis_owner`; runtime harus memakai `gis_app`. |
| Google `redirect_uri_mismatch` | Cocokkan scheme, hostname, port, dan path callback secara tepat dengan Google Console dan `AUTH_URL`; restart aplikasi setelah mengubah `.env`. |
| Google menolak akun penguji | Periksa Audience/Test users dan akun Google yang dipilih. |
| `Invalid Server Actions request` di Codespaces | Tarik kode terbaru, restart server development, lalu buka alamat `-3000.app.github.dev` dan muat ulang paksa browser. |
| `Another next dev server is already running` | Gunakan terminal server yang sudah berjalan atau hentikan dengan Ctrl+C sebelum memulai server baru. |
| `/login?error=Configuration` tanpa sebab jelas | Lihat kategori `[auth][error]` dan `[auth][cause]` di terminal. Hindari membagikan `.env`, token, query callback Google, atau seluruh log mentah. |

## Struktur repository

| Lokasi | Tanggung jawab |
| --- | --- |
| `src/app/` | Halaman login/status/map/admin, layout, CSS Tailwind, server actions, dan route Auth.js. |
| `src/components/portal-shell.tsx` | Tampilan bersama portal dan navigasi sesuai akses akun. |
| `src/auth.ts` | Google provider, database session, callback serta konfigurasi Auth.js. |
| `src/server/auth/` | Identitas Google terverifikasi, adapter database, sinkronisasi akun, bootstrap admin. |
| `src/server/authorization/` | Kebijakan akses dan guard server untuk user, approved user, dan admin. |
| `src/server/users/approval.ts`, `src/app/admin/actions.ts` | Daftar pendaftaran pending dan persetujuan VIEWER dengan validasi server serta audit transaksional. |
| `src/server/db/` | Koneksi PostgreSQL dan schema Drizzle. |
| `src/server/config/` | Validasi konfigurasi server tanpa mencetak nilai secret. |
| `src/types/next-auth.d.ts` | Tipe role/status pada sesi dan user Auth.js. |
| `migrations/` | SQL migration serta metadata Drizzle. |
| `scripts/` | Runner migration, runner integration test, dan CLI perubahan status/role untuk development. |
| `docker/`, `Dockerfile`, `compose.yaml` | Bootstrap role database, build/runtime app, dan service Compose. |
| `tests/`, `vitest*.ts` | Unit test dan integration test. |
| `.env.example` | Daftar konfigurasi tanpa credential nyata. |
| `next.config.ts`, `tsconfig.json`, `postcss.config.mjs`, `eslint.config.mjs` | Konfigurasi Next.js, TypeScript, Tailwind/PostCSS, dan lint. |
| `PLAN.md` | Rancangan jangka panjang; fitur GIS di dalamnya belum diimplementasikan. |


## Daftar approved dan status online

Buka **Administration → Approved accounts**. Setiap baris menampilkan nama (email), titik hijau **Online** atau abu-abu **Offline**, tanggal/jam persetujuan dalam WIB, serta nama (email) administrator pemberi persetujuan. Admin awal yang dibuat melalui `SUPER_ADMIN_EMAILS` ditampilkan sebagai **System (SUPER_ADMIN_EMAILS)** berdasarkan audit. Jika catatan pemberi persetujuan tidak tersedia, aplikasi menyatakannya tanpa menebak identitas.

Daftar diperbarui otomatis setiap 10 detik dan memiliki pagination 20 akun. Online berarti portal terbuka dalam tab yang terlihat; tab mengirim aktivitas setiap 20 detik. Menutup atau menyembunyikan tab mengirim pemberitahuan keluar. Bila browser atau koneksi terputus, aktivitas kedaluwarsa setelah 60 detik; perubahan terlihat pada pembaruan daftar berikutnya (sekitar 70 detik maksimum dalam kondisi normal). Akun tetap online jika tab atau sesi lain masih aktif. Saat pembaruan gagal, status menjadi **Unknown**, bukan menampilkan status lama sebagai informasi terkini.

Untuk menguji: login viewer yang sudah disetujui di browser/profil berbeda, buka `/map`, lalu amati titik hijau di daftar admin. Tutup atau sembunyikan tab viewer dan tunggu pembaruan daftar untuk melihat titik abu-abu. Buka dua tab viewer untuk memastikan menutup satu tab tidak mematikan status tab lain. Daftar akun dan endpoint pembaruannya memvalidasi ADMIN server-side; aktivitas hanya dapat mengubah sesi milik pengguna yang sudah APPROVED.


## Phase 2 — GIS Viewer

Perbarui Codespace dari terminal repo (hentikan `npm run dev` dengan Ctrl+C terlebih dahulu):

```bash
git pull --ff-only origin main
npm ci
docker compose up -d --wait db
npm run db:migrate
npm run dev
```

Migration `0003_gis_viewer.sql` membuat `app.layers` sesuai model PLAN: type/source/state, style, visibility, uploader, timestamps, SRID/CRS, jumlah fitur, bbox PostGIS, serta metadata penyimpanan. Tiga layer demo sintetis sekitar Jakarta otomatis tersedia: **Work areas** (polygon), **Operating routes** (line), dan **Facilities** (point). Migration dicatat satu kali sehingga menjalankannya kembali tidak menggandakan data. Demo ditandai `storage_metadata.demo=true` dan boleh memiliki `uploaded_by=NULL` sebagai data sistem; layer lain tetap wajib mempunyai uploader. Tidak ada akun palsu/admin baru yang dibuat untuk seed.

Geometri disimpan di tiga tabel `gis.layer_<uuid>` dengan primary key dan index GiST. Runtime `gis_app` hanya mendapat SELECT pada katalog dan tabel GIS. Trigger menjaga `updated_at`; migration menggunakan role pemilik database. Nama tabel dan storage metadata tidak dikirim ke browser. Enum RASTER/SHP disiapkan sesuai model PLAN, tetapi belum ada upload, importer, API raster, atau worker.

### Menggunakan viewer

- Login sebagai APPROVED VIEWER atau ADMIN, lalu buka `/map`.
- **Layers:** centang untuk hide/show di browser sendiri; tombol `⌖` memusatkan peta ke layer. Klik titik, garis, atau polygon untuk melihat atribut. Popup memakai text nodes sehingga nilai atribut tidak dieksekusi sebagai HTML.
- **Basemap:** Light canvas dan Dark canvas tersedia tanpa akses jaringan eksternal. OpenStreetMap dapat dipilih untuk peta jalan; pilihan ini membuat browser mengakses tile eksternal dan membagikan IP serta area peta ke provider. Attribution tetap tampil. Provider publik OSM hanya untuk penggunaan interaktif ringan yang sesuai [tile usage policy](https://operations.osmfoundation.org/policies/tiles/), tanpa bulk download/prefetch. Untuk deployment perusahaan berskala besar, ubah daftar server `src/lib/gis/basemaps.ts` ke provider berlisensi/self-hosted. Basemap internal kosong menjadi default.
- **Legend:** simbol dan warna mengikuti layer yang sedang ditampilkan.
- Kontrol kanan atas menyediakan zoom dan fullscreen. Skala meter/kilometer ada di bawah; koordinat pointer memakai longitude/latitude WGS84.
- **Line:** klik sedikitnya dua titik. **Area:** klik sedikitnya tiga titik, lalu **Finish**. Titik bernomor dapat digeser; **Continue** melanjutkan penambahan titik. **Undo point**, **Clear**, dan daftar Selected points dapat menghapus titik. Maksimum 200 titik per pengukuran. Mengganti alat atau kembali ke Explore memulai ulang pengukuran.
- Panjang dapat ditampilkan dalam **m / km**. Luas memakai **m² / ha / km²**, dengan tepat dua digit desimal. Hektar adalah satuan luas sehingga hanya tersedia untuk polygon. Pengukuran memakai jarak/luas geodesik Turf pada permukaan bumi, bukan jarak piksel. Gunakan polygon sederhana tanpa sisi saling berpotongan. Hasil merupakan estimasi, tidak menggantikan survei; pengukuran hanya tersimpan selama halaman terbuka.
- Di ponsel, gunakan **Hide panels / Show panels** untuk membuka ruang peta. Fullscreen mencakup toolbar dan panel agar alat ukur tetap bisa digunakan.

### Akses GIS dan struktur kode

`/map` tetap memanggil `requireApprovedUser()` server-side. Semua `/api/layers`, `/api/layers/:id`, `/api/layers/:id/tiles/:z/:x/:y.pbf`, dan `/api/basemaps` memeriksa sesi dan approval pada setiap request. Tanpa sesi mendapat 401; PENDING/REJECTED mendapat 403. Halaman tetap redirect ke `/login`, `/pending`, atau `/access-denied` sesuai Phase 1. Layer non-READY ditolak untuk semua role; global `is_visible=false` ditolak untuk VIEWER (404), sementara ADMIN boleh preview layer READY yang tersembunyi. Toggle checkbox tidak mengubah global visibility.

Tile menggunakan `ST_TileEnvelope`, spatial prefilter/index, `ST_AsMVTGeom`, dan `ST_AsMVT`. Validasi UUID, rentang Z/X/Y, dan nama tabel dari registry server menjaga batas query. Respons data privat memakai `private, no-store`; katalog diperiksa ulang setiap 30 detik ketika tab aktif, dan layer yang tidak lagi tersedia dilepas dari peta. Data yang sudah diterima browser tidak dapat ditarik kembali secara retroaktif.

| Lokasi | Fungsi |
| --- | --- |
| `src/components/map/` | Browser boundary, MapLibre canvas, viewer, basemap, measurement panel. |
| `src/components/layers/` | Layer panel dan legenda. |
| `src/lib/gis/` | Tipe nonsecret, basemap allowlist, perhitungan/pemformatan ukuran. |
| `src/services/layers/` | Guard API, katalog aman, pembacaan tile PostGIS. |
| `src/app/api/layers/`, `src/app/api/basemaps/` | Endpoint baca yang terproteksi. |
| `migrations/0003_gis_viewer.sql` | Model layer, grants, trigger, dan data demo. |

### Pengujian Phase 2

```bash
npm run lint
npm run typecheck
npm test
npm run build
npm run test:integration
```

Unit test memeriksa jarak/luas geografis, konversi satuan dan dua desimal. Integration test memakai database terisolasi: katalog/metadata/tile/basemap tanpa sesi dan dengan PENDING/REJECTED, tile MVT yang benar-benar didekode, hidden/non-READY layer, parameter tile invalid, pencabutan akses, dan role database read-only.

Uji manual memakai akun VIEWER: lihat tiga layer, toggle tiap layer dan legenda, klik fitur, pilih basemap, coba zoom/fullscreen/skala, buat garis/polygon, geser titik, ganti unit dan undo/clear. Ulangi akses langsung ke `/map` serta API GIS dengan akun PENDING dan REJECTED. Script `predev`/`prebuild` menyalin worker MapLibre versi terpasang beserta lisensinya ke `public/vendor/maplibre/` (generated, di-ignore Git). Worker dilayani dari origin aplikasi sendiri sehingga tidak bergantung CDN dan bisa digunakan di Next.js/Turbopack maupun Docker standalone.

Browser memerlukan WebGL; bila map gagal dimulai, aktifkan hardware acceleration atau gunakan browser yang mendukung. Jika tile OSM tidak dapat diakses, pilih Light/Dark canvas; data GIS internal tetap dapat ditampilkan.


Pengujian browser GIS yang dapat diulang (setelah `npm run build`):

```bash
npx playwright install chromium
npm run test:gis
```

Runner membuat database sementara sendiri dan menghapusnya setelah selesai. Ia menguji WebGL/worker lokal, popup MVT, checkbox/legenda, basemap/attribution, fullscreen/zoom, pengukuran dan pergeseran titik, mobile, serta pencabutan akses. Respons tile OSM dimock hanya pada browser test agar suite deterministik; data GIS internal menggunakan PostGIS nyata. Screenshot disimpan di `test-results/gis/`. Jika Chromium telah tersedia di lokasi lain, gunakan `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH`.
