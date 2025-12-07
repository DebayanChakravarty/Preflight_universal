Place SheetJS browser build here to avoid CDN blocks (client-side .xlsx parsing):
  npm i xlsx@0.20.2
  cp node_modules/xlsx/dist/xlsx.full.min.js vendor/xlsx.full.min.js
The app will try ./vendor/xlsx.full.min.js first.
