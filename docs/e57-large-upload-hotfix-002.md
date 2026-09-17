# E57 HOTFIX 002 – nagy feltöltések diagnosztikája

## Hatókör

Ez a hotfix kizárólag az E57 HTTP-feltöltését érinti. Az E57 feldolgozó, a
LAS-kódolás, az IFC/Revit pipeline és a Viewer változatlan marad.

## Tényleges adatút

Productionben a Viewer `fetch(FormData)` hívása az `/api/projects/:projectId/files`
végpontra érkezik. IIS URL Rewrite/ARR a kérést a `127.0.0.1:3001` Node
szolgáltatásnak továbbítja; fejlesztői módban a Vite proxy ugyanezt az API-t
közvetlenül a Node portra küldi. Az Express route-on a Multer `diskStorage`
közvetlenül a `data/upload-temp` könyvtárba streamel, és csak a teljes multipart
request sikeres lezárása után neveződik át a projekt `uploads` könyvtárába.
E57-konverzió csak ezután indul el, ezért részleges fájl nem kerülhet a workerbe.

A jelenlegi Viewer feltöltési hívása natív `fetch` + `FormData`; nem állít be
Axios-timeoutot, `AbortController`-t vagy kliensoldali időzítőt. Ezért az
esetleges korai megszakadás nem a Viewer üzleti logikájából ered.

Az IIS/ARR ténylegesen beállított proxy-időkorlátja nem olvasható ki a
repository `web.config` fájljából (abban a 4 GiB `maxAllowedContentLength`
szerepel, ARR timeout nem). Ezt a production gépen az IIS/ARR beállításokból
kell ellenőrizni.

## Korábbi és jelenlegi értékek

| Réteg | Korábban | Hotfix után |
|---|---:|---:|
| Node `server.requestTimeout` | Node alapértelmezés: 300 000 ms (5 perc) | 1 800 000 ms (30 perc), véges és explicit |
| Node `server.timeout` | 0 (inaktivitási timeout nincs) | 0 (változatlan) |
| Node `headersTimeout` | 60 000 ms | 60 000 ms |
| Node `keepAliveTimeout` | 5 000 ms | 5 000 ms |
| Multer fájlméret | 20 GiB | 20 GiB, `Number`-ként |
| IIS request filtering | 4 294 967 295 byte (4 GiB) | változatlan |

A 2 147 483 647 byte-os határnál nincs bitwise/int32 konverzió: a
`Content-Length`, a progress-számláló és a Multer limit JavaScript `number`,
és a 2,3 GB-os értékek biztonságosan reprezentálhatók. A kódbázisban nem
található `|0`, `>>`, `<<` vagy signed-int fájlméret-kezelés.

## Diagnosztika és takarítás

Az E57 upload route minden kéréshez request ID-t rendel és naplózza:

- induláskor a route-ot, klienscímet, Content-Lengthet, timeoutot és limitet;
- 30 másodpercenként a fogadott bájtokat, temp fájlméretet, százalékot,
  átviteli sebességet és szabad lemezterületet;
- `aborted`, `close`, request/response error, socket timeout és response finish
  eseményeket;
- hibánál a részletes állapotot és az érintett temp fájlok törlését.

A Multer `diskStorage` miatt a memóriahasználat nem nő a teljes fájlmérettel.
Abort vagy Multer-hiba esetén a middleware a még meglévő temp fájlokat törli,
és a route handler nem indít konverziót.

## Root-cause státusz

A rendelkezésre álló korábbi hiba (`IncomingMessage` `aborted`, Multer stack,
konverzió előtti megszakadás) upstream/socket-szintű abortot bizonyít, nem
Multer fájlméret-hibát. A repositoryból önmagában nem különíthető el, hogy a
Node 5 perces alapértelmezett request timeoutja vagy az IIS/ARR proxy timeoutja
zárta-e le a production socketet. A hotfix explicit 30 perces Node request
budgetet és olyan diagnosztikát ad, amely a következő futásban ezt egyértelműen
megkülönbözteti (`requestId`, socket timeout, `clientAborted`, progress és
temp-file méret alapján).

## Validációs korlát

A repositoryban rendelkezésre áll 2 941 350 912 és 6 300 713 984 byte-os E57
forrás, de a teljes böngészős újrafeltöltést ebben a környezetben nem futtattuk
le, mert az órákig tarthat és a production proxy állapotát nem reprodukálja.
A kis, 270 MB-os kontrollfájl és a 2,3 GB-os production fájl végső kézi
ellenőrzését a szerveren kell elvégezni; a logok már tartalmazzák a szükséges
összehasonlítható mérőszámokat.
