# CLAUDE.md

Project rules for coding assistants (Claude Code reads this file) and for human
contributors.

## What this is

A Gladys Assistant **external integration**: a Node.js service (Node 22+, ESM,
no build step) that runs in its own sandboxed Docker container and talks to
Gladys through
[`@gladysassistant/integration-sdk`](https://github.com/GladysAssistant/integration-sdk-js),
with `jpeg-js` (the encoder of `src/artwork-resize.js`) as its only other runtime
dependency. It started from the official JavaScript template.

## Commands

```bash
npm install
npm test                                  # node --test, the built-in runner
node --test test/devices.test.js          # one file
node --test --test-name-pattern "plug"    # tests whose name matches
npm run lint                              # ESLint
npm run format:check                      # Prettier, as the CI runs it
npm run format                            # Prettier, fix in place
npx github:GladysAssistant/integration-store .   # store admission checks
```

The CI (`.github/workflows/ci.yml`) runs `format:check`, `lint` and `test` on
Node 22 and 24, and builds the Docker image: run the three commands before
pushing.

## Architecture

```
index.js                          SDK wiring only: handlers registered before connect()
src/app.js                        registers every SDK handler on the hub (tests use the same wiring)
src/config.js                     DEFAULT_CONFIG (mirrors the manifest defaults) + normalization, 4 slots
src/hub.js                        one record per server: devices, states, transports, status, scene events, commands
src/player.js                     one Mopidy server: connection, events, readings, commands, notifications
src/mopidy/client.js              JSON-RPC over HTTP (batches) + the event WebSocket, errors by kind
src/mopidy/model.js               Mopidy answers -> plain objects (status, track, playlists)
src/devices.js                    the device of a server, its features, the now-playing snapshot (publishNowPlaying)
src/catalog.js                    Gladys 5.3 music panel: browse, search, play, queue, artwork bytes (manifest `music`)
src/artwork-resize.js             self-contained: an artwork the core refuses (> 300 KB) -> JPEG ≤ 400 px, pure JS
src/scenes.js                     scene action handlers (manifest `scene_actions`)
src/widgets.js                    the `player` dashboard widget (manifest `widgets`)
src/texts.js, src/issues.js       messages in four languages; repeated failures logged once
gladys-assistant-integration.json manifest: name, config_schema, actions, image...
docs/{en,fr,de,es}.md             user documentation, re-hosted by Gladys (en and fr mandatory)
test/                             node --test, against the SDK's fake Gladys and a fake Mopidy (test/helpers/)
.github/scripts/release.mjs       release helpers (manifest bump, changelog), tested in test/
```

## Rules

- **External ids are forever.** Build them with
  `gladys.externalIds(type, platformId)`, `platformId` being the unique id the
  platform gives the device (serial, cloud id, MAC), never a label. Gladys keys
  devices, their history, scenes and dashboards on them: changing one creates a
  new device and orphans the old one. The same goes for every key users store:
  manifest `config_schema`, `actions`, widget and scene keys, feature keys.
- **The container rootfs is read-only.** Write only under `/data`, the one
  writable volume. Never log tokens, passwords or API keys.
- **Versions belong to the Release workflow** (Actions → Release). Never edit
  `version` in `package.json` or in the manifest, nor the `docker_image` tag,
  by hand — except on the README's hand-pushed tag path, which bumps all three
  together before tagging. `test/manifest.test.js` checks they agree.
- **Changelog.** Every user-visible change adds a line under `## [Unreleased]`
  in `CHANGELOG.md` (`### Added`, `Changed`, `Fixed`, `Removed`, `Security`).
  Never write a version heading: the Release workflow moves the section, and it
  becomes the notes of the GitHub Release.
- **Manifest.** Texts are multi-language objects `{ "en": ..., "fr": ... }`:
  `label`, `description` and `placeholder` alike, never a plain string. The
  catalog `description` holds 10 to 100 characters per language. A field the
  older cores do not know needs a higher `gladys_version` minimum
  (`categories`: 4.86.0; `widgets`, `scene_triggers`, `scene_actions`,
  `type: "provider"`: 5.1.0). `test/manifest.test.js` ties the manifest to the
  code (defaults, action, scene and widget handlers): change both sides
  together.
- **User-facing text** exists in English, French, German and Spanish: action
  messages, manifest texts, and `docs/{en,fr,de,es}.md`, kept in sync
  (`test/i18n.test.js`).
- **Style.** Prettier formats, ESLint catches mistakes. Comments explain why,
  in English. Tests never touch the network.

---

# Notes du mainteneur (guim31)

Ce qui suit complète les règles du template ci-dessus. Ce sont des faits vérifiés dans le code du
cœur Gladys ou payés sur les intégrations déjà publiées par guim31. Ils ne se lisent pas dans le
code de ce dépôt. Compléter ce fichier quand un nouveau piège est découvert.

## Travailler sur ce dépôt

- Mêmes étapes que la CI, dans le même ordre : `npm ci`, `npm run format:check`, `npm run lint`,
  `npm test`. Prettier contrôle **aussi le Markdown** : lancer `npm run format` après avoir
  modifié ce fichier, le README ou la documentation, sinon la CI tombe.
- Une session de code n'a **ni instance Gladys ni appareil réel**. La suite de tests, le lint et
  le validateur du store sont les seules vérifications possibles : le test réel se fait ailleurs.
  Le dire, plutôt que de conclure que « ça marche ».
- **Tout le code de démonstration du template disparaît** : station météo, prise, lampe, caméra,
  capteur de mouvement, `src/weather.js`, leurs tests, leurs entrées du manifeste et de la
  documentation. Il ne reste que ce que l'intégration fait vraiment.
- **Publier n'est jamais le travail d'une session de code** : ni Release, ni tag, ni topic, ni
  version modifiée à la main. L'orchestrateur s'en charge une fois la PR fusionnée. Les workflows
  sont ceux du template : ne pas les modifier.
- Le dépôt est **public** : aucun secret, aucune adresse ni détail d'infrastructure privée, ni
  ici, ni dans les tests, ni dans les captures.

## Pièges du cœur Gladys

**Appareils et fonctionnalités**

- **Polling** : le planificateur n'interroge un appareil que si `should_poll: true` **et**
  `poll_frequency` vaut une valeur de la liste fixe, **en millisecondes** (1000, 2000, 10000,
  15000, 30000, 60000). Le template publie `poll_frequency: 300` sans `should_poll` : c'est faux,
  le cœur répond 400 à la découverte. Pour une cadence hors liste, publier `should_poll: false` et
  pousser les états depuis le conteneur, en gardant un `onPoll` de repli.
  **Piège du 5.2.0** (GladysAssistant/Gladys#3198, correctif #3199, relevé sur gladys-ping-wol) :
  un appareil **créé sans `should_poll`** n'est jamais sondé, même après correction du cœur (valeur
  stockée à la création), et la 5.2.1 du 13/10/2026 ne le corrige pas. **Le conteneur sonde donc
  lui-même** par un minuteur, qui saute un appareil sondé il y a moins d'une demi-période, en gardant
  `onPoll` comme repli ; seuls les appareils ajoutés (`gladys.devices`) sont lus. Un test le prouve
  sans appeler `onPoll`.
- **`min` et `max` sont NOT NULL** dans `t_device_feature`, y compris pour `text/text` : sans eux,
  « Ajouter à Gladys » échoue en HTTP 422. Mettre 0/0, comme Zigbee2MQTT.
- Un état publié sur une fonctionnalité **pas encore ajoutée** dans Gladys reçoit un 200 puis est
  jeté (simple ligne de log) : republier les états dans `onDeviceCreated`.
- `level-sensor/decimal` n'existe pas côté serveur. `light-sensor/binary` n'a pas de libellé dans
  le front (pastille vide) : préférer `input/binary`. Un `text/text` reçoit `{ text }`, jamais
  vide, sinon l'état est ignoré.
- **Détecteur d'ouverture (`opening-sensor`) : 0 = ouvert, 1 = fermé** (`OPENING_SENSOR_STATE`), à
  l'inverse de l'intuition et des autres détecteurs (mouvement, fuite, fumée : 1 = détecté). Une
  porte ouverte publiée à 1 s'affiche « Fermé » et fausse scènes et historique. Le figer par un test.
- **Un `external_id` de fonctionnalité ne change jamais d'appareil** d'une version à l'autre. UniFi
  1.5.2 avait sorti les ports PoE dans un appareil dédié, la 1.6.0 les a remis dans la passerelle avec
  les mêmes identifiants : ceux qui avaient ajouté l'appareil dédié ne peuvent plus « Mettre à jour » la
  passerelle (409 `external_id must be unique`). Pour regrouper, garder l'appareil existant
  (`gladys.getDevices()`) ou changer d'identifiant.
- Les **noms de fonctionnalités sont figés à la création**. Et quand une fonctionnalité est seule
  de son type sur l'appareil, le tableau de bord affiche le libellé générique du type à la place
  du nom publié.
- **Aucune commande d'appareil ne permet un choix multiple** : un `text/select` n'a qu'un choix
  actif.
- Un changement de structure fait proposer « Mettre à jour » dans l'onglet Découverte
  (`structure_changed`). Un changement des seules `supported_options` ne le déclenche pas.
- **Jauge** : l'aiguille se place par `(value - min) / (max - min)` des bornes de la
  fonctionnalité. `gauge_min`/`gauge_max` ne pilotent que les couleurs, et le cœur n'applique
  jamais `min`/`max` en écriture : ce sont des bornes d'affichage. Une valeur signée exige des
  bornes symétriques.
- Le cœur plafonne à **300 états par minute** et réévalue les scènes à chaque état : ne publier
  que les changements.
- Une intégration `device` ne reçoit pas la langue de l'utilisateur, une action de scène non
  plus (un widget, si) : prévoir un champ de config `language` si des textes partent du
  conteneur. Le superviseur injecte `TZ`, le fuseau de Gladys. La sandbox est limitée à 256 Mo.

**Formulaires de configuration et actions**

- Les champs `number` sont rendus **sans `step`** : le navigateur n'accepte alors que `min + k`.
  Min et défaut **entiers** seulement ; une valeur décimale passe par un `select` ou par un
  `string` parsé (virgule acceptée).
- Un champ `secret` dans les `fields` d'une **action** est impossible à remplir, et une action
  n'applique **aucun `default`** tout en exigeant les champs `required` (422). Issues
  GladysAssistant/Gladys#3154 et #3155.

**SDK 0.15 et journaux**

- SDK `@gladysassistant/integration-sdk` **^0.15.0** (12/10/2026) : `DEVICE_POLL_FREQUENCIES`, faux
  Gladys de test (`@gladysassistant/integration-sdk/testing`, à préférer à un faux maison),
  déduplication des états, `parseMdnsTxt`. Lire son README et son CHANGELOG.
- **Journaux calmes** (demande de Guilhem, 13/10/2026) : rien au niveau info pour un cycle normal de
  lecture, un état publié ou un message reçu. L'info ne garde que le cycle de vie : démarrage,
  connexion, perte et retour d'un appareil ou d'un service, erreurs utiles, une ligne par action de
  l'utilisateur. Le reste passe en debug (`LOG_LEVEL=debug`). Une erreur qui se répète écrit une ligne
  au premier échec et une au rétablissement, pas une par tentative. Jamais de secret ni d'adresse
  avec identifiants. Un test vérifie qu'un cycle normal n'écrit rien en info.
- **Heartbeat** : republier au moins toutes les 12 h une valeur qui ne change pas, sinon le front
  affiche « Pas de valeur récente » au-delà de 48 h.

**Widgets, déclencheurs, actions de scène (SDK ≥ 0.14, Gladys ≥ 5.1)**

- **Cibler la dernière version publiée du cœur, pas `master`** : la spec de `master` décrit des
  fonctions non publiées. Les boutons de widget qui ouvrent un formulaire (#3168, commit 3feb2cf8)
  sont absents de la 5.1.4 mais **livrés dans la 5.2.0** (sortie le 12/10/2026) : `gladys_version`
  `>=5.2.0` si on s'en sert, ou un bouton direct en repli. Vérifier par `git tag --contains`.

- Un réglage de widget ne propose en liste que les **appareils** de l'intégration
  (`source: "devices"`, seule source dynamique).
- Budget du cœur : **8 composants par widget, dont 2 textes au plus**, appliqué **avant** la
  résolution des références ; un contenu amputé reste en cache jusqu'au TTL. Appeler
  `requestWidgetRefresh` à la création d'un appareil. `validateWidgetContent` est exporté pour les
  tests, mais ne vérifie pas que les `external_id` liés existent : les croiser avec `buildDevice`.
- Une ligne de `status` exige un `value` (nombre ou texte ≤ 40).
- Le cœur **jette un bouton dont la clé d'action est déjà prise** : clés numérotées.
- Le vocabulaire des widgets n'a ni liste ni curseur, **par choix** du cœur. Seul un bouton
  `device_feature` numérique a un état actif natif.
- **En mode sombre, le style `primary` d'un bouton de widget ne se voit pas** (#3153) : signaler
  un choix courant par l'icône (`check-circle`), jamais par le style.
- Dans une grille `card-list`, la `date` s'affiche **à la place** du sous-titre.
- `onWidgetAction` fait recharger le widget dès la résolution, alors que `requestWidgetRefresh`
  est plafonné à un appel toutes les 10 s. Un toast d'action est tronqué à 200 caractères.
- Le cœur met le contenu d'un widget en cache par (réglages, langue, unités) : pré-localiser
  d'après `language` est correct.
- Les filtres de scène ne font qu'égalité et appartenance : un seuil reste le travail d'un capteur.
- **Les clés de widgets, de déclencheurs et d'actions sont figées une fois publiées.**
- `gladys_version` `>=5.1.0` dès qu'il y a widgets, déclencheurs ou actions de scène.

## Store

- Validateur officiel, depuis la racine : `npx -y github:GladysAssistant/integration-store .`
  (schéma, `description` **100 caractères au plus par langue**, documentation de 300 caractères
  au moins, image Docker, cover de **150 Ko au plus**). Il demande Node ≥ 24 mais tourne sous
  Node 22 avec un avertissement.
- L'indexeur lit le manifeste de la **dernière release**, pas celui de `main` : une correction du
  manifeste (catégorie, description…) n'atteint le store qu'avec une release.
- L'indexeur rejette **en silence** : la raison n'apparaît que dans `rejected.json`, à côté de
  `https://integration-store-storage.gladysassistant.com/index.json`.
- **Image de base** : `FROM public.ecr.aws/docker/library/node:…` (miroir officiel ECR Public, même
  empreinte) et non `node:…` de Docker Hub, qui refuse en 429 les pulls anonymes des runners GitHub
  dès qu'il y a plusieurs builds à la fois. Un échec 429 dans le job « Docker build » n'est pas un bug
  du code. Même parade dans `.github/workflows/build.yml` (posée par l'orchestrateur, ne pas la
  retirer) : QEMU et BuildKit tirés de `mirror.gcr.io`.
- La règle `data/` du `.gitignore` du template (pour le volume `/data`) exclut aussi `src/data/` :
  l'ancrer en `/data/`, dans `.prettierignore` aussi.

### Langues (depuis le 11/10/2026)

Tout texte montré à l'utilisateur existe en **`en`, `fr`, `de` et `es`** : manifeste, contenu des widgets, messages,
noms de fonctionnalités. L'allemand **tutoie** (« du »), l'espagnol **vouvoie** (« usted ») : décision de Guilhem,
appliquée à ses 21 intégrations. `test/i18n.test.js` doit échouer sur une langue manquante, un texte vide ou trop
long, et sur un « Sie »/« Ihr… » de politesse en allemand. Le store exige `docs/en.md` et `docs/fr.md`
(`DOCS_LANGUAGES`) et publie aussi `docs/de.md` et `docs/es.md` quand ils existent
(`DOCS_OPTIONAL_LANGUAGES` d'integration-store) : écrire les quatre, avec les mêmes sections.

## Choix par défaut de Guilhem (12/10/2026)

- Langue par défaut des noms de fonctionnalités et des textes produits par le conteneur : **`fr`**.
- Fichier `LICENSE` Apache-2.0 (texte complet) à la racine.
- `transports` : `local` seul quand le cloud n'est qu'une option annexe.
- Docs `en`, `fr`, `de`, `es` avec les mêmes sections.
- Chauffe, ouverture, sécurité : ne rien rendre pilotable « comme un thermostat » ou par un assistant
  vocal quand une erreur serait dangereuse (leçon d'OctoPrint).

## Mopidy (propre à cette intégration)

- **API native** : Mopidy-HTTP, JSON-RPC 2.0 sur `POST /mopidy/rpc` (lots acceptés, réponses dans
  l'ordre des id) et WebSocket d'événements `/mopidy/ws`. `Content-Type: application/json` obligatoire
  (415 sinon, protection CSRF). Aucune authentification. Mêmes réponses sur **3.4.2** (paquet Debian 13)
  et **4.0.5** (PyPI), à part des champs `null` en plus dans les `Track` de la 4 :
  `test/fixtures/mopidy/` (enregistrées le 24/10/2026, voir son README).
- Une erreur JSON-RPC vaut `{ code: 0, message: "Application error", data: { type, message, traceback } }` :
  la raison est dans `data.message`, jamais journaliser le `traceback`.
- **`play` répond avant de changer de piste** (vu sur 3.4 et 4.0) : la lecture suivante peut encore
  montrer l'ancienne piste en pause, et un `seek` envoyé dans le même lot que `play` est perdu.
  D'où le délai de grâce d'une notification (`startGraceMs`) avant de la juger ratée, et la reprise en
  deux temps (`restorePosition` : attendre que la piste soit courante, puis `pause` et `seek`).
- Un fichier illisible (`file:///…` absent) est accepté par `tracklist.add` mais `play` ne fait rien et
  n'annonce rien : seul l'absence de `track_playback_started` dans le délai le dit. Une URI dont aucun
  backend ne connaît le schéma n'est pas ajoutée du tout (`[]`).
- En mode `single`, Mopidy s'arrête après la piste et la piste courante devient `null`.
  `tracklist.remove` d'un tlid inconnu ne lève pas d'erreur. Le `seek` marche en pause.
- Notifications (relecture du 24/10) : une adresse `http(s)` n'est une radio que si Mopidy ne lui donne
  pas de longueur (la voix de « Parler sur une enceinte » en a une) ; une notification attend la remise
  en place de la précédente (`this.ending`) avant de sauvegarder l'état ; `onSetValue` ne fait que lancer
  la notification (Gladys attend 5 s, Mopidy lit d'abord le flux) ; les journaux ne montrent d'une adresse
  web que son hôte (jeton et texte de la voix dans le chemin).
- La WebSocket n'est qu'un accélérateur : « connecté » veut dire que le JSON-RPC répond. Sans elle (proxy),
  la lecture du minuteur (30 s) suffit, et la WebSocket est rouverte à chaque tick.
- Le formulaire d'un bouton de widget est limité à **4 champs** (`validateWidgetContent`) : le muet n'y
  est pas, c'est une fonctionnalité de l'appareil (`music/mute` depuis la 1.1.0).
- **Lecteur Musique 5.3 (1.1.0)** : `publishNowPlaying` à chaque lecture (le SDK fait le diff, la
  position ne repart que sur changement d'état ou de piste, ou un saut > 3 s) ; seul le texte « En cours »
  passe encore par `publishChangedStates`. `playback-state` garde son identifiant (d'où
  `featureExternalIds`), les nouvelles suivent `${device}:${type}`. Le muet `switch/binary` de la 1.0 est
  devenu `music/mute` sous le même identifiant : `device.create` du cœur met à jour catégorie et type
  d'une fonctionnalité retrouvée par `external_id` quand l'utilisateur clique « Mettre à jour ».
- **Catalogue (vérifié sur 3.4.2 + Mopidy-Local 3.3.0, et 4.0.5)** : `library.browse` rend tout le niveau
  (pagination faite ici) ; une URI de playlist M3U ne se parcourt ni ne se lit par `browse`/`add` (`[]`) :
  passer par `playlists.get_items` ; **ajouter l'URI d'un dossier crée une fausse piste qui fait planter
  Mopidy 3.4 (segfault GStreamer) à la lecture** : un dossier n'est jamais jouable ; `tracklist.index`
  garde la piste courante après `stop`. La recherche de Mopidy-Local ne rend que des pistes.
- **Pochettes** : `library.get_images` donne des chemins sur le serveur (`/local/<hash>.jpeg`), à la taille
  du fichier (Mopidy-Local ne redimensionne pas) ; au-delà de 300 Ko, `catalog.artwork` lit jusqu'à
  10 Mo puis `src/artwork-resize.js` (1.1.1) en fait un JPEG de 400 px au plus, en JS pur. Ce module est
  **autonome** (rien de Mopidy, `jpeg-js` pour l'encodage seulement) et se copie tel quel dans d'autres
  dépôts : le garder ainsi. Décodeur JPEG maison réduit par l'IDCT (1/2, 1/4, 1/8) parce que jpeg-js
  décode en entier (~25 o/pixel : un 3000 × 3000 prend 200 Mo, un 4096 × 4096 tue un conteneur de 256 Mo) ;
  PNG gonflé en flux, ligne par ligne. Mesuré dans un conteneur de 256 Mo : +30 Mo au plus jusqu'à
  6000 × 4000, 2 s au pire (progressif). Fixtures `test/fixtures/artwork/` comparées à jpeg-js. Le paquet
  Debian 13 `mopidy-local` 3.2.1 est cassé (import de `imghdr`, absent de Python 3.13) : le banc prend
  `mopidy-local==3.3.0` de PyPI (+ `uritools`, `python3-setuptools`).
- Banc de test réel : `Dockerfile` Debian trixie + `apt install mopidy` (ou `pip install mopidy` pour la
  4), `[audio] output = fakesink sync=true`, fichiers générés par `gst-launch-1.0 audiotestsrc`, playlists
  M3U ; réseau Docker `gladys-test-mopidy`, sans port publié.
