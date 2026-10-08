# Company GIS Portal — Phase 4

Portal internal dengan login Google, persetujuan akun, dan akses berdasarkan role. Phase 1 mencakup Next.js + TypeScript, Tailwind CSS, PostgreSQL + PostGIS, Drizzle ORM/migration, Docker Compose, serta authentication dan authorization di server.

Phase 2 **GIS Viewer** tersedia di `/map` menggunakan MapLibre GL JS, vector tile PostGIS, panel layer/basemap/legenda, popup atribut, dan pengukuran. Phase 3 menyediakan dashboard, approval akun, status online/offline, serta `/admin/users` untuk approve, reject, perubahan role, filter dan pencarian. **Phase 4** menambahkan upload ZIP Shapefile, worker import PostGIS, serta pengelolaan nama/deskripsi, visibility dan penghapusan layer melalui `/admin/layers`. Tidak ada seed GIS contoh. Raster/GeoTIFF dan fase berikutnya belum diimplementasikan. Cakupan fondasi mengikuti instruksi Phase 1 pengguna; penomoran awal di [PLAN.md](PLAN.md) memisahkan authentication menjadi fase tersendiri.

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

4. Siapkan login database khusus worker (setelah migration), lalu jalankan worker di terminal terpisah:

   ```bash
   npm run gis:setup -- --write-env
   npm run worker:gis
   ```

   Worker lokal menggunakan Linux/WSL dengan `ogr2ogr` di PATH dan binding GDAL Python tersedia melalui `/usr/bin/python3`. Untuk macOS atau lingkungan yang belum mempunyai dependency ini, gunakan seluruh stack Compose sebagaimana dijelaskan pada bagian Phase 4. `gis:setup -- --write-env` membuat password worker acak bila belum ada, mengatur role `gis_worker`, dan menyimpan URL/password secara privat ke `.env.local` jika file itu ada, atau `.env`. Perintah ini tidak menampilkan secret dan tidak mengubah akun aplikasi.

5. Di terminal lain, jalankan aplikasi dan biarkan terminal tetap aktif:

   ```bash
   npm run dev
   ```

6. Setelah muncul `Ready`, buka <http://localhost:3000/login>. Untuk Codespaces gunakan alamat port yang diteruskan seperti dijelaskan di bawah.

Database, server development, dan worker harus berjalan agar upload diproses. Setelah membuka kembali Codespaces, jalankan database, migration, worker dan server lagi; setup login worker cukup diulang jika konfigurasi berubah. Migration mencatat versi yang sudah diterapkan, sehingga boleh dijalankan kembali. Login dan pembacaan peta yang sudah diimpor tetap bekerja tanpa worker; upload baru akan menunggu di antrean.

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
| `GIS_WORKER_DB_PASSWORD` | Password terpisah untuk role `gis_worker`; minimal 24 karakter. Dapat dibuat dan disimpan oleh `npm run gis:setup -- --write-env`. |
| `GIS_WORKER_DATABASE_URL` | URL role `gis_worker`, dihasilkan setup lokal. Worker tidak boleh memakai `DATABASE_URL` atau URL owner migration. |
| `GIS_STORAGE_ROOT` | Direktori privat bersama web/worker; default `./data/gis`, atau `/data/gis` dalam Compose. Bukan direktori `public/`. |
| `GIS_UPLOAD_MAX_MB` | Batas ZIP, default 50 MiB; rentang konfigurasi 1–250. |
| `GIS_EXTRACT_MAX_MB` | Batas total ekstraksi, default 250 MiB; rentang 1–1024. |
| `GIS_ENTRY_MAX_MB` | Batas satu entry ZIP, default 200 MiB; rentang 1–512. |
| `GIS_MAX_FEATURES` | Batas fitur per dataset, default 500000; rentang 1–2000000. |
| `GIS_PROCESS_TIMEOUT_SECONDS` | Timeout ekstraksi/perintah GDAL, default 300 detik; rentang 10–600. |

Sesuaikan kedua connection URL bila nama database atau port diubah. Password hex dari perintah di atas aman dipakai langsung dalam URL; password lain harus di-URL-encode. Compose membuat URL koneksi internalnya sendiri dengan hostname `db` dari variabel database; aplikasi yang dijalankan menggunakan `npm` memakai URL `localhost`.

`gis_app` mempunyai hak terhadap tabel akun dan sesi serta hanya `SELECT/INSERT` terhadap audit. Phase 4 menambahkan INSERT/UPDATE katalog dan enqueue job untuk web; tabel geometry tetap hanya dapat dibaca oleh web. `gis_worker` mempunyai hak import pada schema `gis_staging`/`gis`, finalisasi katalog/job dan audit, tanpa hak mengubah akun/sesi. `gis_owner` dipakai untuk migration/setup login, bukan runtime web atau worker. Migration mengaktifkan PostGIS tanpa membuat layer contoh.

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

Untuk integration test, nyalakan PostgreSQL/PostGIS dan pastikan konfigurasi privat berisi `MIGRATION_DATABASE_URL` milik owner, `DATABASE_URL` milik `gis_app`, serta `GIS_WORKER_DATABASE_URL` milik `gis_worker` pada server database yang sama. Jalankan migration dan `npm run gis:setup -- --write-env` lebih dahulu. Owner memerlukan izin membuat database dan memasang extension PostGIS; `gis_owner` dari Compose memenuhi kebutuhan ini. Suite import memerlukan dependency GDAL lokal yang dijelaskan pada bagian Phase 4. Siapkan build terlebih dahulu:

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

Pastikan `GIS_WORKER_DB_PASSWORD` sudah diisi dengan password terpisah minimal 24 karakter. Perintah `docker compose up -d --wait db` dapat dijalankan sebelum password worker dibuat; menjalankan stack lengkap tetap memerlukan password tersebut karena service `migrate` harus mengaktifkan login worker. Compose memulai `db`, menjalankan service `migrate` setelah database sehat, lalu memulai `app` dan `worker` setelah migration serta konfigurasi login worker berhasil. `migrate` yang selesai dengan exit code 0 adalah normal. Container app menggunakan build Next.js standalone dan user non-root; GDAL hanya dipasang di image worker. OAuth tetap membutuhkan konfigurasi Google dan `AUTH_URL` yang cocok dengan alamat browser.

Pada server deployment gunakan origin HTTPS dan reverse proxy tepercaya yang diarahkan ke port aplikasi lokal. Compose membatasi port app/database ke `127.0.0.1`; GitHub Pages tidak dapat menjalankan aplikasi ini karena membutuhkan server Node.js dan PostgreSQL. Worker tidak mempunyai port HTTP publik. Batas container worker: memori 1 GiB, satu CPU, dan 64 proses; Compose memberi waktu 15 menit untuk menyelesaikan pekerjaan saat penghentian normal.

Data akun dan geometry disimpan di named volume `postgres_data`; file upload sementara berada di volume privat `gis_data` yang dipakai bersama app/worker. `docker compose stop` menghentikan service tanpa menghapusnya. Pembuatan ulang container mempertahankan volume; hindari `docker compose down -v` untuk data yang ingin disimpan. Backup database mencakup geometry hasil import. Hentikan penerimaan upload/worker sebelum membuat backup terkoordinasi database dan storage bila masih ada job berjalan; source ZIP yang sudah selesai diproses tidak disimpan sebagai arsip permanen.

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
| `PLAN.md` | Rancangan jangka panjang dan status implementasi Phase 1–4. |


## Daftar approved dan status online

Buka **Administration → Approved accounts**. Setiap baris menampilkan nama (email), titik hijau **Online** atau abu-abu **Offline**, tanggal/jam persetujuan dalam WIB, serta nama (email) administrator pemberi persetujuan. Admin awal yang dibuat melalui `SUPER_ADMIN_EMAILS` ditampilkan sebagai **System (SUPER_ADMIN_EMAILS)** berdasarkan audit. Jika catatan pemberi persetujuan tidak tersedia, aplikasi menyatakannya tanpa menebak identitas.

Daftar diperbarui otomatis setiap 10 detik dan memiliki pagination 20 akun. Online berarti portal terbuka dalam tab yang terlihat; tab mengirim aktivitas setiap 20 detik. Menutup atau menyembunyikan tab mengirim pemberitahuan keluar. Bila browser atau koneksi terputus, aktivitas kedaluwarsa setelah 60 detik; perubahan terlihat pada pembaruan daftar berikutnya (sekitar 70 detik maksimum dalam kondisi normal). Akun tetap online jika tab atau sesi lain masih aktif. Saat pembaruan gagal, status menjadi **Unknown**, bukan menampilkan status lama sebagai informasi terkini.

Untuk menguji: login viewer yang sudah disetujui di browser/profil berbeda, buka `/map`, lalu amati titik hijau di daftar admin. Tutup atau sembunyikan tab viewer dan tunggu pembaruan daftar untuk melihat titik abu-abu. Buka dua tab viewer untuk memastikan menutup satu tab tidak mematikan status tab lain. Daftar akun dan endpoint pembaruannya memvalidasi ADMIN server-side; aktivitas hanya dapat mengubah sesi milik pengguna yang sudah APPROVED.


## Phase 2 — GIS Viewer

Untuk update lengkap termasuk worker Phase 4, ikuti langkah development di atas. Perintah berikut cukup untuk menjalankan viewer yang sudah mempunyai data (hentikan `npm run dev` dengan Ctrl+C terlebih dahulu):

```bash
git pull --ff-only origin main
npm ci
docker compose up -d --wait db
npm run db:migrate
npm run dev
```

Migration `0003_gis_viewer.sql` membuat `app.layers` sesuai model PLAN: type/source/state, style, visibility, uploader, timestamps, SRID/CRS, jumlah fitur, bbox PostGIS, serta metadata penyimpanan. Instalasi baru tidak membuat layer atau akun contoh. `/map` menampilkan **No GIS layers available.** sampai tersedia data perusahaan.

Layanan vector tile mendukung tabel `gis.layer_<uuid>` dengan primary key dan index GiST. Runtime `gis_app` hanya mendapat SELECT pada tabel geometry GIS; hak katalog/antrean Phase 4 terpisah dari hak DDL worker. Trigger menjaga `updated_at`; migration menggunakan role pemilik database. Nama tabel dan storage metadata tidak dikirim ke browser. Import SHP ditambahkan pada Phase 4; enum RASTER disiapkan sesuai PLAN tetapi API/pipeline raster belum dibuat.

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
| `migrations/0003_gis_viewer.sql` | Model layer, grants dan trigger; tanpa seed data. |

### Pengujian Phase 2

```bash
npm run lint
npm run typecheck
npm test
npm run build
npm run test:integration
```

Unit test memeriksa jarak/luas geografis, konversi satuan dan dua desimal. Integration test memakai database terisolasi: katalog/metadata/tile/basemap tanpa sesi dan dengan PENDING/REJECTED, tile MVT yang benar-benar didekode, hidden/non-READY layer, parameter tile invalid, pencabutan akses, dan role database read-only.

Uji manual memakai akun VIEWER: pastikan panel layer kosong tanpa error, pilih basemap, coba zoom/fullscreen/skala, buat garis/polygon, geser titik, ganti unit dan undo/clear. Toggle/legenda/popup tetap tersedia untuk layer perusahaan; fixture vector tile hanya dibuat di database pengujian terisolasi. Ulangi akses langsung ke `/map` serta API GIS dengan akun PENDING dan REJECTED. Script `predev`/`prebuild` menyalin worker MapLibre versi terpasang beserta lisensinya ke `public/vendor/maplibre/` (generated, di-ignore Git). Worker dilayani dari origin aplikasi sendiri sehingga tidak bergantung CDN dan bisa digunakan di Next.js/Turbopack maupun Docker standalone.

Browser memerlukan WebGL; bila map gagal dimulai, aktifkan hardware acceleration atau gunakan browser yang mendukung. Jika tile OSM tidak dapat diakses, pilih Light/Dark canvas; data GIS internal tetap dapat ditampilkan.


Pengujian browser GIS yang dapat diulang (setelah `npm run build`):

```bash
npx playwright install chromium
npm run test:gis
```

Runner membuat database sementara sendiri dan menghapusnya setelah selesai. Ia menguji peta kosong dengan WebGL/worker lokal, basemap/attribution, fullscreen/zoom, pengukuran dan pergeseran titik, mobile, pencabutan akses, serta dashboard/manajemen user melalui browser. Respons tile OSM dimock hanya pada browser test agar suite deterministik; uji API vector tile memakai fixture PostGIS nyata pada suite integration. Screenshot disimpan di `test-results/gis/`. Jika Chromium telah tersedia di lokasi lain, gunakan `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH`.


## Phase 3 — Dashboard dan manajemen pengguna

Buka **Administration → Users** (`/admin/users`) sebagai APPROVED ADMIN. Dashboard `/admin` menyediakan jumlah total/PENDING/APPROVED/REJECTED/admin, shortcut filter, quick approval dan daftar approved beserta aktivitas online/offline yang sudah ada. Menu **Layers** dan **Upload Data** kini aktif untuk fitur Phase 4.

Tabel Users menampilkan nama, email, status, role, waktu pendaftaran, administrator pemberi approval, waktu approval, dan tindakan. Tanggal memakai WIB; semua waktu disimpan sebagai timestamptz. Filter status/role serta pencarian nama/email dilakukan di server dengan 20 akun per halaman. Approved By menampilkan **System / unavailable** bila akun tidak memiliki atribusi administrator manusia; informasi historis tidak direkayasa.

- **Approve**: berlaku untuk PENDING atau REJECTED. Status menjadi APPROVED, `approved_by` berasal dari sesi admin, dan `approved_at` dicatat. Role awal tetap VIEWER; jika admin secara eksplisit mengubah role sebelumnya, role tersebut dipertahankan. Approval untuk role ADMIN meminta konfirmasi.
- **Reject**: meminta konfirmasi, mengubah status menjadi REJECTED, mengosongkan metadata approval, dan mencabut semua sesi akun itu. Saat login Google kembali, akun diarahkan ke `/access-denied`. Riwayat keputusan tetap ada dalam tabel audit yang sudah tersedia.
- **Save role**: memilih VIEWER/ADMIN dan meminta konfirmasi. Perubahan role langsung berlaku pada request berikutnya, termasuk sesi yang sudah terbuka. Perubahan role tidak mengganti atribusi/waktu approval.
- Formulir yang sudah kedaluwarsa ditolak ketika akun telah berubah. Review ulang data yang diperbarui sebelum mengulangi tindakan.
- Akun dalam `SUPER_ADMIN_EMAILS` diberi label **Protected administrator**; server menolak penolakan/demotion. Admin approved terakhir juga tidak boleh ditolak/didemote, termasuk diri sendiri dan dua request bersamaan. Admin boleh menurunkan role sendiri jika ada admin approved lain; setelah itu halaman admin tidak lagi bisa dibuka.

### Migration pembersihan GIS

Jalankan `npm run db:migrate` setelah update kode. `0004_remove_gis_demo.sql` hanya menghapus tiga ID/tabel demo bawaan lama bila **ID, nama tabel, source GEOJSON, penanda demo, dan uploader NULL semuanya cocok**. Layer lain dan seluruh user/sesi/audit dipertahankan. Migration tidak menggunakan CASCADE, tidak mereset database, serta tidak membuat ulang demo.

Atas permintaan penghapusan seed, bagian INSERT/geometri contoh pada migration `0003` juga dihapus agar instalasi baru langsung kosong. Schema historis dan snapshot tetap tersedia; database yang sudah menerapkan `0003` dibersihkan oleh migration maju `0004`. Ini pengecualian terarah terhadap pedoman tidak mengubah migration lama; tidak perlu menghapus volume atau menjalankan ulang `0003`. Constraint uploader khusus demo diganti dengan uploader nullable untuk layer yang dikelola sistem; upload Phase 4 selalu merekam uploader terautentikasi. Tidak ada perubahan schema user atau tabel user duplikat.

Referensi `demo` yang masih ada hanya untuk identifikasi cleanup, metadata migration historis, dokumentasi upgrade, dan assertion pengujian. `mock`/fixture pada automated test tetap diperlukan dan hanya dibuat di database sementara. Tidak ada seed demo pada startup, build, atau migrasi instalasi baru.

### Struktur dan keamanan

| File | Tanggung jawab |
| --- | --- |
| `src/app/admin/page.tsx` | Dashboard, statistik, navigasi, quick approval dan presence. |
| `src/app/admin/users/page.tsx` | Tabel pengguna, filter, pencarian, pagination, metadata approval. |
| `src/app/admin/users/actions.ts` | Server Action `changeUser`: approve/reject/role, validasi form dan pesan aman. |
| `src/components/admin/` | Navigasi admin dan kontrol perubahan dengan konfirmasi. |
| `src/server/users/management.ts` | Query daftar/statistik, transaksi perubahan, pemeriksaan actor/target dan perlindungan admin. |
| `src/lib/users/management.ts` | Validasi input, normalisasi filter, URL internal dan daftar pesan error. |
| `migrations/0004_remove_gis_demo.sql` | Cleanup terarah dan penghapusan constraint khusus demo. |
| `tests/integration/user-management.test.ts` | Uji database, race admin terakhir, rollback audit, pencarian dan cleanup. |
| `tests/integration/routes.test.ts` | Uji halaman dan POST Server Actions pada build production. |
| `scripts/test-gis-browser.mjs` | Runtime peta kosong dan alur administrasi dengan browser Chromium. |

Tidak ada API publik CRUD pengguna baru. Tindakan menggunakan Server Actions dengan `requireAdmin()`, validasi ulang actor APPROVED/ADMIN dan Google account yang tertaut **di dalam transaksi**, serta pemeriksaan origin bawaan Next.js. UUID/action/role divalidasi; identitas administrator tidak diambil dari form. Lock transaksi yang sama dipakai oleh bootstrap, quick approval dan CLI sehingga pengecekan admin terakhir tidak bisa dilampaui oleh request paralel. Perubahan user, pencabutan sesi, dan penambahan audit bersifat atomik. Error database/SQL/credential tidak dikirim sebagai pesan ke pengguna.

### Cara menguji Phase 3

```bash
npm run lint
npm run typecheck
npm test
npm run build
npm run test:integration
npm run test:gis
```

Semua fixture otomatis dibuat di database `portal_test_<acak>` terpisah dan dibuang seusai pengujian. Tidak perlu seed akun di database aplikasi.

1. Login Google sebagai admin, buka `/admin` lalu **Users**. Periksa filter, pencarian, pagination, statistik, daftar approved dan indikator aktivitas.
2. Login akun Google kedua → PENDING. Dari Users, approve akun tersebut. Refresh `/pending` di browser akun kedua → `/map` tanpa login ulang; periksa role VIEWER dan atribusi/tanggal approval.
3. Sebagai VIEWER, buka `/admin` dan `/admin/users` langsung → `/access-denied`. Coba `/map` → map kosong tetap dapat dipakai, dengan basemap, koordinat dan pengukuran.
4. Promosikan akun kedua menjadi ADMIN, konfirmasi, lalu buka `/admin/users` pada sesi akun kedua yang sama → dapat diakses. Turunkan kembali ke VIEWER → akses admin ditolak pada request berikutnya.
5. Klik Reject lalu batalkan: akun tidak berubah. Ulangi dan konfirmasi: sesi akun kedua dicabut. Login Google lagi → `/access-denied`. Akun bisa di-approve kembali dari filter Rejected.
6. Coba demote/reject admin terakhir atau akun konfigurasi bootstrap: server menolak. Pengujian otomatis juga mencoba POST manual dengan role/status yang tidak berhak serta dua demotion bersamaan.
7. Pada database lama, setelah migration, pastikan tiga layer contoh hilang dan akun/data perusahaan tetap ada. Pada database baru, pastikan tidak ada layer yang dibuat otomatis.

Login Google nyata tetap memerlukan credential dan redirect URI milik lingkungan Anda. Browser test otomatis memakai sesi terisolasi, bukan menghubungi Google, dan tidak menambahkan login bypass ke aplikasi. Tidak ada upload/import SHP/GeoTIFF, GDAL, styling editor, advanced layer management, atau audit system baru dalam Phase 3.

## Phase 4 — Upload Shapefile dan manajemen layer

Phase 4 menambahkan **Administration → Upload Data** (`/admin/upload`) dan **Layers** (`/admin/layers`). Halaman, API, dan transaksi mutasi memerlukan pengguna Google terverifikasi dengan status APPROVED dan role ADMIN. Akun VIEWER tetap hanya dapat membaca layer READY yang visible di `/map`; akun PENDING/REJECTED tidak dapat membaca GIS. Login, approval, pengelolaan user dan presence dari fase sebelumnya tetap digunakan.

### Format ZIP dan CRS

Satu ZIP harus berisi **satu dataset** dengan `.shp`, `.shx`, `.dbf`, dan `.prj` yang memiliki basename serta folder yang sama, misalnya `batas.shp`, `batas.shx`, `batas.dbf`, `batas.prj`. `.cpg` opsional diteruskan kepada GDAL untuk decoding atribut sesuai encoding dataset. Sidecar Shapefile yang dikenal seperti `.sbn`, `.sbx`, `.qix`, dan `.shp.xml` diizinkan; ZIP bersarang atau file format lain ditolak. Berkas boleh berada dalam satu subfolder, tetapi bukan path absolut, traversal `..`, symlink, atau path tersembunyi. Entry duplikat diperiksa tanpa membedakan huruf besar/kecil dan setelah normalisasi Unicode.

`.prj` wajib. CRS kosong, tidak terbaca, atau tidak dikenali menghasilkan pesan aman; aplikasi tidak mengasumsikan EPSG:4326 dan belum menyediakan input manual untuk memaksa EPSG. Siapkan/ekspor `.prj` yang benar pada aplikasi GIS sebelum upload. GDAL membaca CRS sumber, lalu mentransformasikan geometry ke **EPSG:4326** untuk penyimpanan; `source_srid` disimpan bila otoritas EPSG dikenali, serta WKT CRS sumber tetap dicatat. CRS WKT yang valid tanpa nomor EPSG dapat dipakai bila GDAL mampu mentransformasikannya dengan data proyeksi lokal.

Geometry yang diterima: **Point, MultiPoint, LineString, MultiLineString, Polygon, MultiPolygon**. Dataset kosong, geometry NULL/kosong/tidak valid, geometry collection atau campuran keluarga geometry, dan hasil di luar longitude/latitude WGS84 ditolak. Import tidak diam-diam melewati fitur rusak; jumlah fitur hasil harus cocok dengan metadata sumber. Atribut DBF disimpan sebagai JSONB; metadata geometry dan ID internal terpisah. Batas format/nama kolom Shapefile tetap mengikuti file asal. Nilai popup dirender sebagai teks, bukan HTML.

### Menjalankan worker lokal atau Docker

Setelah dependency terpasang dan database berjalan:

```bash
npm run db:migrate
npm run gis:setup -- --write-env
npm run worker:gis
```

Jalankan `npm run dev` pada terminal lain. Web dan worker lokal harus memakai `GIS_STORAGE_ROOT` yang sama. Worker Linux/WSL memerlukan executable `ogr2ogr` dan modul `osgeo` pada Python sistem, misalnya dari paket distribusi `gdal-bin` dan `python3-gdal`. Periksa keduanya sebelum import:

```bash
ogrinfo --version
ogr2ogr --version
/usr/bin/python3 -c 'from osgeo import gdal, ogr; print(gdal.VersionInfo("RELEASE_NAME"))'
```

Inspeksi CRS/geometry/jumlah fitur memakai `src/server/processing/inspect-shapefile.py` melalui API GDAL, sedangkan import memakai `ogr2ogr`. Driver input dibatasi ke ESRI Shapefile; saat import, `GDAL_SKIP` menonaktifkan driver lain kecuali pembaca Shapefile dan penulis PostgreSQL. Tidak ada ketergantungan pada opsi `ogrinfo -json` atau `ogr2ogr -if` yang belum tersedia di GDAL 3.6. Image worker mem-pin paket Debian Bookworm `gdal-bin=3.6.2+dfsg-1+b2` beserta binding Python dependensinya. Alur browser upload sampai penghapusan telah lulus dengan worker host GDAL **3.10.3** dan, secara terpisah, worker image Docker GDAL **3.6.2**.

Untuk memakai GDAL yang disediakan image worker, jalankan **seluruh stack Compose** sebagaimana instruksi Docker di atas. Jangan mencampur web host yang memakai `./data/gis` dengan worker Compose yang memakai named volume `gis_data`: keduanya harus melihat file upload yang sama. Jika menggunakan `.env.local`, ingat bahwa Compose secara default membaca `.env`; pastikan konfigurasi database/worker yang diperlukan juga disediakan ke Compose secara privat.

Migration baru **`0005_vector_upload_jobs.sql`** membuat antrean `app.gis_jobs`, index/constraint, schema `gis_staging`, dan role `gis_worker` yang awalnya NOLOGIN. `gis:setup` kemudian mengatur login/password menggunakan koneksi owner migration. Tidak ada user aplikasi atau data demo yang dibuat. Tidak perlu menghapus volume database. Role worker tidak superuser dan tidak dapat membuat database/role atau memodifikasi akun/sesi. Web tidak menjalankan GDAL dan tidak memiliki izin CREATE/DROP pada schema GIS.

### Alur upload, edit dan delete

1. Login sebagai ADMIN, buka **Upload Data**, pilih ZIP, isi nama unik, deskripsi opsional dan **Visible to approved viewers**.
2. **Upload shapefile** menampilkan progress transfer, lalu status antrean/pemrosesan. Transfer 100% belum berarti layer sudah berhasil diimpor.
3. Web menyimpan ZIP ke storage privat dengan ID server, kemudian membuat layer `PROCESSING` dan job `QUEUED` dalam transaksi. Worker mengambil job, memvalidasi/mengekstrak ZIP, memeriksa metadata, dan mengimpor ke tabel staging khusus attempt.
4. Setelah validasi geometry/atribut, worker mempublikasikan tabel `gis.layer_<uuid>`, primary key, index GiST, metadata, audit dan status `READY` dalam transaksi. Layer parsial tidak disajikan kepada viewer. Setelah sukses, pilih **View on map** untuk memusatkan peta pada extent layer.
5. Di **Layers**, lihat geometry, jumlah fitur, CRS penyimpanan, status, visibility, uploader dan tanggal dalam WIB. **Edit details** mengganti nama/deskripsi. Checkbox visibility mengatur akses global viewer; berbeda dari toggle pribadi di peta.
6. **Delete** meminta konfirmasi lalu mengubah status menjadi `DELETING`, sehingga data segera berhenti dilayani. Worker menghapus tabel geometry, registry dan mencatat audit secara transaksional. File upload terkait dibersihkan. Penghapusan bersifat permanen; batalkan dialog jika masih perlu menyimpan data.

Hanya layer SHP dengan penanda internal `portal-shapefile-v1` dan pemetaan tabel yang cocok yang boleh diedit/dihapus melalui menu ini. Layer eksternal/legacy tetap terlihat sebagai **Managed outside this portal** dengan tindakan mutasi dinonaktifkan; API juga menolak percobaan manual. Tidak ada endpoint untuk memasukkan SQL, nama tabel atau path storage dari browser.

Daftar admin diperbarui setiap 10 detik pada tab aktif; katalog peta diperbarui setiap 30 detik. Tombol refresh juga tersedia. Setelah hide/delete, request katalog/metadata/tile berikutnya langsung mengikuti keputusan server; data yang sudah diterima browser sebelumnya tidak dapat ditarik kembali. Jika polling jaringan gagal, UI menyediakan **Check processing status** atau **Check deletion status**; periksa status sebelum mengirim ulang upload.

### Batas dan pemulihan pekerjaan

Default ZIP **50 MiB**, ekstraksi total **250 MiB**, satu entry **200 MiB**, maksimal **32 entry** termasuk folder, dan rasio kompresi per entry maksimal **100:1**. Ukuran hasil dekompresi dan CRC diperiksa saat streaming, bukan hanya mempercayai header ZIP. Arsip terenkripsi, rusak, multipart yang tidak sesuai, file tambahan yang tidak dikenal dan upload melewati batas ditolak dengan pesan aman. Ada satu stream upload aktif per admin, maksimal dua job aktif per admin dan sepuluh job aktif total untuk penerimaan upload baru.

Default dataset maksimal **500000 fitur** dan timeout proses **300 detik**; sesuaikan variabel `.env` hanya setelah mengukur kapasitas mesin. Endpoint MVT membatasi satu tile pada **10000 kandidat fitur**, output **2 MiB**, dan query database **5 detik**. Batas kepadatan/ukuran menghasilkan HTTP **422** (`TILE_TOO_DENSE`/`TILE_TOO_LARGE`), sedangkan query yang melewati timeout menghasilkan HTTP **503** (`TILE_TIMEOUT`); fitur tidak dipotong diam-diam menjadi hasil parsial. Perbesar peta untuk mempersempit area tile, atau kurangi kompleksitas/atribut dataset jika ukuran tetap berlebih. Semua fitur tetap disimpan di database. Belum ada clustering, generalisasi, feature search baru, styling editor, atau pipeline raster.

Worker memproses satu job pada satu waktu per proses, dengan claim atomik, lease **90 detik**, heartbeat **20 detik**, dan pemeriksaan recovery sekitar **30 detik**. Kegagalan koneksi/lock database sementara dicoba ulang maksimal tiga attempt; arsip/CRS/geometry yang tidak valid menjadi FAILED tanpa retry otomatis. Worker lama yang kehilangan lease tidak boleh mempublikasikan hasil. Recovery membersihkan staging/orphan dan mencoba ulang claim yang kedaluwarsa hingga batas attempt. Import FAILED tetap ada pada daftar admin untuk diperiksa/dihapus, tetapi tidak tampil pada peta. Perbaiki dataset lalu hapus entry gagal atau gunakan nama berbeda saat upload ulang. Delete yang gagal tetap tersembunyi dalam `DELETING` sampai pekerjaan cleanup diselesaikan.

Pemeriksaan hak actor diulang sebelum import dan sebelum publikasi; admin yang dicabut haknya selama proses tidak dapat menerbitkan layer. Delete yang sudah sah diantrekan tetap menyelesaikan cleanup bila hak actor kemudian berubah. Audit upload/edit/delete memakai tabel audit yang sudah ada. ZIP sumber dan direktori ekstraksi dibersihkan setelah job terminal; simpan salinan sumber sendiri jika diperlukan untuk arsip. Recovery juga memeriksa direktori upload/attempt yang ditinggalkan, termasuk crash sebelum enqueue. Direktori baru dibiarkan setidaknya **15 menit** (lebih lama jika timeout konfigurasi memerlukan), lalu status job diperiksa kembali sebelum penghapusan agar upload atau attempt aktif tetap aman. Worker harus berjalan agar rekonsiliasi ini dilakukan; kegagalan izin/disk perlu diperbaiki operator. Storage bukan arsip sumber permanen.

### API dan file Phase 4

| Endpoint | Fungsi |
| --- | --- |
| `GET /api/admin/uploads` | Konfigurasi batas upload dan token CSRF terikat sesi admin. |
| `POST /api/admin/uploads` | Multipart `file`, `name`, `description`, `isVisible`; menerima job dengan HTTP 202. |
| `GET /api/admin/layers` | Katalog admin, metadata uploader, status dan token CSRF. |
| `PATCH /api/admin/layers/:id` | JSON nama, deskripsi dan visibility layer terkelola. |
| `DELETE /api/admin/layers/:id` | Mengantrekan cleanup layer, HTTP 202. |
| `GET /api/admin/jobs/:id` | Status QUEUED/RUNNING/SUCCEEDED/FAILED dan kategori error aman. |

POST/PATCH/DELETE wajib menyertakan header `x-gis-csrf` dari endpoint GET dengan sesi yang sama serta Origin portal yang valid. Token terkait user dan sesi, bukan secret global yang dikirim ke browser. Tidak ada sesi mendapat 401; PENDING/REJECTED/VIEWER mendapat 403. Mutasi juga memeriksa kembali role/status dan identitas tertaut dalam transaksi. Error invalid ZIP/CRS/metadata memakai kode/pesan tetap; SQL, stack GDAL, connection URL, token sesi, dan path privat tidak dikirim ke UI. Respons privat memakai `no-store`.

| File/lokasi | Tanggung jawab |
| --- | --- |
| `src/app/admin/upload/`, `src/app/admin/layers/` | Halaman admin yang dilindungi server. |
| `src/components/admin/shapefile-upload.tsx`, `layer-manager.tsx`, `gis-requests.ts` | Form, progress/polling, metadata, visibility dan konfirmasi delete. |
| `src/app/api/admin/uploads/`, `layers/`, `jobs/` | Route handlers upload, katalog, mutasi dan status job. |
| `src/server/layers/` | Guard admin/CSRF, reservasi nama, enqueue dan metadata/audit. |
| `src/server/processing/` | Batas, pesan aman, validasi ZIP, helper metadata Python GDAL dan eksekusi GDAL tanpa shell. |
| `src/server/storage/local.ts` | Penyimpanan lokal privat dan cleanup upload. |
| `src/server/jobs/worker.ts`, `scripts/gis-worker.ts` | Claim/lease/retry, staging, import, publikasi dan cleanup. |
| `scripts/configure-gis-worker.ts` | Konfigurasi login worker tanpa mencetak credential. |
| `migrations/0005_vector_upload_jobs.sql` | Antrean dan hak database worker/web; tanpa seed. |
| `tests/shapefile-archive.test.ts`, `tests/integration/vector-workflow.test.ts` | Fixture arsip, pipeline GDAL/PostGIS dan regresi izin/lifecycle. |
| `scripts/test-vector-browser.mjs` | Uji upload hingga render/popup/edit/delete dengan browser, database dan storage terisolasi. |

### Pengujian dan troubleshooting Phase 4

Verifikasi 8 Oktober 2026: lint, TypeScript, **111 unit test**, **138 integration test**, production build, migration baru/idempotent, browser GIS/User Management dan browser upload-vector **lulus**. Uji runtime menggunakan PostgreSQL/PostGIS nyata, GDAL, Chromium, serta database dan storage sementara. Audit dependency production setelah pembaruan `yauzl` ke 3.4.0 melaporkan **0 vulnerability**. Untuk mengulang, jalankan pada lingkungan development dengan PostgreSQL/PostGIS, GDAL dan Chromium:

```bash
npm run lint
npm run typecheck
npm test
npm run build
npm run test:integration
npm run test:gis
npm run test:vector
```

Untuk menguji image worker yang sudah dibangun, pada Linux:

```bash
docker build --target worker -t company-gis-worker:phase4 .
GIS_TEST_WORKER_IMAGE=company-gis-worker:phase4 npm run test:vector
```

Mode ini menjalankan web production build pada host dan worker di container, dengan database/storage pengujian yang sama. Host networking hanya dipakai harness pengujian ini. Build image dan alur browser tersebut lulus pada 8 Oktober 2026; ini bukan klaim bahwa deployment Compose lengkap sudah diuji dengan credential Google lingkungan Anda.

Test menggunakan database/storage terisolasi dan fixture otomatis, tanpa membuat layer contoh pada database aplikasi. Login Google nyata, CRS/data perusahaan, kapasitas dataset maksimum, dan deployment produksi tetap perlu verifikasi pada lingkungan tujuan.

1. Login ADMIN, upload ZIP point/line/polygon valid termasuk versi Multi; tunggu READY. Periksa jumlah fitur, posisi, atribut popup dan extent di peta. Uji CRS sumber non-4326 dan `.cpg` untuk teks non-ASCII.
2. Login APPROVED VIEWER di profil terpisah; layer visible tampil, toggle pribadi, legenda dan popup bekerja. Nonaktifkan global visibility sebagai admin: viewer tidak boleh memperoleh tile/metadata baru, sementara admin tetap dapat preview.
3. Ganti nama/deskripsi. Coba nama yang sudah terpakai. Batalkan dialog delete, pastikan data tetap ada; konfirmasi delete kemudian pastikan layer hilang dari katalog/peta dan tabel geometry dihapus.
4. Upload ZIP tanpa `.shx`, `.dbf`, `.prj`, dengan CRS rusak, dataset kosong, ekstensi palsu dan ukuran berlebih. Pastikan tidak ada layer READY parsial dan error UI tidak membocorkan detail internal.
5. Coba `/admin/upload`, `/admin/layers` serta endpoint admin tanpa sesi dan memakai VIEWER/PENDING/REJECTED. Coba mutasi tanpa CSRF/Origin yang sah; server harus menolak sebelum menyimpan data.
6. Hentikan worker, kirim ZIP sebagai admin: job menunggu QUEUED. Nyalakan worker kembali dan pastikan pemrosesan berlanjut. Untuk pengujian crash/lease gunakan database terisolasi; jangan menghapus file/tabel secara manual ketika job masih aktif.

| Gejala | Pemeriksaan |
| --- | --- |
| Job terus QUEUED | Pastikan `npm run worker:gis` atau service `worker` hidup, migration selesai, dan koneksi khusus worker benar. |
| `GDAL_UNAVAILABLE` / inspeksi metadata gagal | Periksa `ogr2ogr --version` dan impor `osgeo` melalui `/usr/bin/python3` di lingkungan worker; untuk Compose bangun ulang image worker. |
| `MISSING_PRJ` / `UNKNOWN_CRS` | Sertakan `.prj` basename yang sama dan ekspor ulang dengan CRS asal yang benar; jangan mengganti label CRS untuk memaksa posisi. |
| `GDAL_FAILED` / `INVALID_GEOMETRY` | Validasi dataset/encoding/geometry di aplikasi GIS; import tidak mengabaikan fitur rusak. |
| `STORAGE_ERROR` | Pastikan web/worker menggunakan root privat yang sama dan user proses dapat menulis; jangan memberi akses publik ke direktori ini. |
| Koneksi worker ditolak atau `gis_worker` tidak dapat login | Jalankan migration lalu `npm run gis:setup -- --write-env` pada development; periksa konfigurasi privat Compose untuk stack Docker. |
| Nama sudah digunakan / layer sibuk | Refresh Layers; tunggu job selesai, ubah nama atau hapus entry gagal setelah ditinjau. Jangan mengirim upload berulang karena polling terputus. |
| Layer READY tetapi tidak terlihat / tile HTTP 422 atau 503 | Periksa global visibility, checkbox pribadi, tombol View on map/fit extent, dan perbesar zoom pada dataset padat. `TILE_TOO_DENSE`/`TILE_TOO_LARGE` memakai HTTP 422; query melewati 5 detik mengembalikan HTTP 503 `TILE_TIMEOUT`. |
| Penghapusan gagal dan layer DELETING | Pulihkan koneksi/storage, lalu pilih **Check / retry delete** di Layers. Job aktif dipantau tanpa membuat duplikat; job yang sudah gagal dapat diantrekan ulang. Layer tetap tidak disajikan selama penghapusan. |

Phase 4 berhenti pada upload/import Shapefile dan pengelolaan layer dasar. GeoTIFF/raster, GDAL raster, style editor lanjutan, GeoJSON upload, dan perubahan deployment di luar Compose development belum dikerjakan.
