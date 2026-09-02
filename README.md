# Voyag'heure

PWA mobile installable pour gérer hors-ligne les billets de **n'importe quel
voyage ou événement** : transport, hébergement, billets d'événement. Import
PDF avec pré-remplissage automatique, planning et budget générés à partir
des données saisies — rien n'est codé en dur pour un voyage en particulier.

Tout est **100% local** : les voyages, les entrées et les PDF sont stockés
dans IndexedDB sur l'appareil. Il n'y a pas de backend, rien n'est envoyé
sur un serveur.

## Structure

```
index.html              Écran unique : accueil (liste des voyages) + écran
                          d'un voyage (onglets Entrées / Planning / Budget)
manifest.json             Manifeste PWA (nom "Voyag'heure", icônes, couleurs)
sw.js                      Service Worker (cache l'app-shell + pdf.js pour
                            l'usage hors-ligne)
css/style.css              Styles (mobile-first, ~380px, palette
                            aubergine/corail/rose, codes couleur par type)
js/db.js                   IndexedDB : stores "trips", "entries" et
                            "correctionRules" (préférences apprises)
js/parser.js                Extraction PDF positionnelle (pdf.js) + heuristiques
                            de détection (type, dates, heure, prix, lieu,
                            adresse, référence) avec confiance et apprentissage
js/reminders.js               Rappels locaux (Notification API + Service
                            Worker) : réglages, permission, planification
js/app.js                    Logique de l'app (navigation, formulaires, rendu)
vendor/pdfjs/                pdf.js (Mozilla), vendored pour fonctionner
                            hors-ligne sans dépendre d'un CDN
icons/                        Icônes PNG générées par scripts/generate-icons.js
scripts/generate-icons.js    Générateur d'icônes (sans dépendance externe)
```

## Modèle de données

Tout vit dans IndexedDB (base `voyagheure-db`), rien dans le code :

**`trips`** — un voyage/événement créé par l'utilisateur : nom, lieu, date de
début, date de fin.

**`entries`** — une entrée rattachée à un voyage (un billet importé, ou une
dépense ajoutée à la main) :

| Champ | Description |
|---|---|
| `type` | `transport` / `event` (billet événement) / `lodging` (hébergement) / `other` |
| `title` | Titre affiché |
| `startDate`, `startTime` | Date et heure de début (optionnelles) |
| `endDate`, `endTime` | Date et heure de fin (optionnelles, ex. check-out d'un hôtel) |
| `place` | Lieu (nom du venue/gare/hôtel) |
| `address` | Adresse postale libre (rue, ville, code postal) — sert au bouton 📍 |
| `latitude`, `longitude` | Coordonnées GPS optionnelles, capturées via « Enregistrer ma position ici » (pas de géocodage automatique) — affinent le bouton 📍 et l'estimation de trajet du Planning |
| `price` | Montant en € (optionnel) — `null` si l'entrée fait partie d'un **billet combiné** (voir plus bas) |
| `reference` | Référence / numéro de commande — idem, vide si billet combiné |
| `paymentStatus` | `paid` / `due` / `estimate` — idem, sans effet si billet combiné |
| `reminderMode` | `default` (réglage global) / `custom` (voir `reminderMinutes`) / `none` |
| `reminderMinutes` | Délai personnalisé en minutes, utilisé seulement si `reminderMode: 'custom'` |
| `pdfBlob` | Le fichier original (`Blob`, PDF **ou image**) — `null` si billet combiné (voir `documents`) |
| `documentId` | Si renseigné, cette entrée fait partie d'un **billet combiné** : son prix/référence/statut/PDF vivent sur le document partagé, pas sur elle-même |

**`documents`** — le "document source" d'un **billet combiné** : un seul
PDF (même QR code/code-barres) qui couvre plusieurs événements distincts
(ex. un pass festival multi-jours). Porte le PDF, le prix **total**, la
référence et le statut de paiement, comptés **une seule fois** pour tous
les événements qu'il couvre :

| Champ | Description |
|---|---|
| `pdfBlob`, `pdfName` | Le PDF original, partagé par toutes les entrées qui le référencent |
| `price` | Montant total en € |
| `reference` | Référence / numéro de commande, partagée |
| `paymentStatus` | `paid` / `due` / `estimate`, partagé |

**`checklistItems`** — un élément de la checklist d'un voyage (onglet
dédié) : `text` (libre), `checked` (coché/non coché). Aucune suggestion de
contenu automatique — une liste vide que l'utilisateur remplit lui-même.

Le Planning et le Budget sont **entièrement dérivés** de ces entrées (et
documents) : aucune donnée de planning/budget n'est stockée séparément.

## Import intelligent

Le bouton d'import accepte la **sélection de plusieurs fichiers à la
fois** (PDF et/ou images mélangés) : chacun passe séquentiellement par le
flux d'extraction/confirmation habituel — un formulaire de confirmation
par fichier, à la suite, sans avoir à relancer l'import un par un.

Pour chaque PDF → `js/parser.js` reconstruit d'abord les
**lignes de chaque page à partir de la position (x, y)** de chaque fragment
de texte que fournit pdf.js (`item.transform`), triées dans l'ordre de
lecture naturel — pas une simple concaténation en une seule chaîne. Un champ
est associé à sa valeur par **proximité spatiale** : un libellé ("Départ",
"Total", "Commande"...) puis sa valeur sur la même ligne, ou à défaut sur la
ligne suivante (mises en page en tableau) — plutôt qu'un regex sur du texte
plat où l'ordre peut être ambigu.

Heuristiques appliquées :

- **Type** : score pondéré de mots-clés — transport (FlixBus, SNCF, gare,
  aéroport, vol, Départ/Arrivée...), hébergement (Hostelworld, Booking.com,
  Airbnb, check-in/out, Nuit...), événement (Portes/Doors, salle, billet,
  concert...) — un mot-clé fort (nom de fournisseur) pèse plus qu'un mot-clé
  faible (Départ/Arrivée, qui peut aussi apparaître sur une confirmation
  d'hôtel), pour éviter les faux classements.
- **Dates** : `JJ.MM.AAAA`, `JJ/MM/AAAA`, et en toutes lettres en français
  et en anglais (`28 août 2026`, `28 August`, mois abrégés). La première
  date trouvée devient la date de début, la dernière (si différente) la
  date de fin.
- **Heure** : formats `14:30` ou `14h30`.
- **Prix** : `24,00 €`, `€ 24,00`, `24,00 EUR`, `99,50 Euro`, en priorité sur
  une ligne contenant "Total"/"Prix"/"Montant" — un montant labellisé
  "sous-total"/"partiel" passe après les autres par défaut. (Le symbole `€`
  n'est pas une "frontière de mot" : le regex utilise une négation
  explicite plutôt que `\b` pour ne pas rater un montant en toute fin de
  ligne, cas le plus courant sur un ticket.)
- **Lieu** : libellés lieu/venue/destination/départ/arrivée, en écartant
  les candidats qui ressemblent à une date plutôt qu'à un lieu.
- **Adresse** : une ligne « code postal + ville » (`75012 Paris`,
  `1013 AK Amsterdam`...) combinée à la ligne précédente si elle ressemble
  à un nom de rue.
- **Référence** : libellés référence/commande/réservation/booking/ticket
  id/confirmation, soit suivis d'un code sur la même ligne, soit — mise en
  page en colonnes où le libellé et le code sont sur deux lignes séparées —
  une ligne entièrement dédiée au code juste en dessous.

Le formulaire de confirmation est **toujours** pré-rempli avec ces valeurs :
l'utilisateur valide ou corrige, il ne saisit jamais un billet depuis zéro.

### Confiance et texte source

Sous chaque champ pré-rempli avec une détection fiable, un petit texte
italique indique l'extrait source (« détecté depuis : « Total : 24,00 € » »).
Un champ que l'import n'a pas pu détecter avec confiance **reste vide**
plutôt que de deviner, et est signalé par une bordure corail + « ⚠️ à
vérifier » à côté de son libellé — y compris **tous** les champs d'une
image importée, puisqu'aucune extraction de texte n'y est faite (voir plus
bas).

### Mémorisation des corrections

Quand plusieurs candidats existent pour un champ (ex. plusieurs montants —
sous-total, taxes, total), chacun garde le libellé qui l'a introduit. Si
l'utilisateur corrige le champ pré-rempli vers un **autre** candidat détecté
sur le même document, Voyag'heure retient ce libellé comme préférence pour
ce type de document (`js/db.js`, store `correctionRules`, clé = signature du
document + nom du champ) et l'applique dès le prochain import du même type
— avant l'heuristique par défaut. Signature de document : nom du
fournisseur connu détecté (`flixbus`, `hostelworld`...) sinon le type
détecté (`type:transport`, etc.). Pas de machine learning : une simple
table `(document, champ) → libellé préféré`, mise à jour à chaque
correction. Champs concernés : prix, référence, adresse, lieu.

Le bouton **« Ajouter manuellement »** ouvre le même formulaire vide, pour
les dépenses sans PDF ni photo (nourriture estimée, souvenirs...).

### Billets combinés (un PDF, plusieurs événements)

Certains billets couvrent **plusieurs événements distincts avec le même QR
code/code-barres** — typiquement un pass festival multi-jours. Pendant
l'extraction, `js/parser.js` détecte la répétition d'un motif "en-tête jour
de la semaine (Ven./Sam./Mon.../Ven. 28 août/Thursday:...) suivi d'un
libellé Starts/Location + adresse" — un bloc par occurrence :

- **Un seul bloc détecté** (ou aucun) → comportement inchangé, import
  classique d'une entrée unique.
- **Plusieurs blocs détectés** → la confirmation d'import bascule sur un
  écran dédié : un **titre partagé** pré-rempli depuis le texte du document
  (pas le nom de fichier, qui peut avoir perdu apostrophes/esperluettes lors
  de l'enregistrement du téléchargement), la **liste des événements
  détectés** (titre, jour, heure, lieu, adresse), modifiable un par un, plus
  **un seul** champ de prix et **une seule** référence pour l'ensemble du
  billet (jamais demandés événement par événement).

Mise en page en colonnes (ex. Jeudi/Vendredi à gauche, Samedi/Dimanche à
droite dans le PDF) : comme le texte de deux colonnes voisines en hauteur se
retrouve entrelacé dans l'ordre d'extraction de pdf.js, les lignes sont
d'abord regroupées par colonne (proximité horizontale) puis chaque bloc est
découpé à l'intérieur de sa colonne — un découpage linéaire naïf mélangerait
sinon des lignes de deux événements différents. Gère aussi bien un lieu
étalé sur plusieurs lignes sous un libellé "Location:" qu'une mise en page
compacte sans libellé (ancrage sur la ligne "code postal + ville", le lieu
étant celle juste au-dessus) ; l'heure accepte le format 24h ("17:30") et le
format 12h anglophone ("5PM", "11:30pm"). Quand un bloc ne porte qu'un nom de
jour (pas de date explicite), Voyag'heure la resitue dans la période globale
du document si elle est indiquée quelque part sous la forme "date - date"
(ex. "Datum: 29.08.2024 - 01.09.2024" → "Thursday" devient 2024-08-29).

À la validation, Voyag'heure crée **un document partagé** (`documents`,
avec un titre, le PDF, le prix total, la référence et le statut de
paiement) puis **une entrée par événement** détecté, chacune pointant vers
ce document via son `documentId` — son propre prix/référence/statut/PDF
restent `null`.

Effets sur le reste de l'app :

- **Planning** : les événements apparaissent normalement, chacun à sa
  date/heure ; cliquer sur l'un d'eux ouvre le **même** PDF partagé (le
  QR/code-barres du billet).
- **Entrées** : au lieu d'une carte par événement, une **seule carte
  « Billet combiné »** liste les événements couverts en sous-titre ; son
  bouton ✎ ouvre l'édition du prix/référence/statut partagés, son bouton ✕
  supprime le document **et** toutes ses entrées liées (avec confirmation
  mentionnant leur nombre).
- **Budget** : le prix du document est compté **une seule fois**, quel que
  soit le nombre d'événements qu'il couvre — pas de double comptage. Modifier
  le statut de paiement ou le montant se fait une fois, pour tout le billet.
- Éditer un événement individuel (titre, heure, lieu...) depuis Planning ou
  Entrées masque les champs prix/référence/statut (avec une note explicative)
  puisqu'ils ne s'appliquent pas à un seul événement du billet.

### Import d'une image (PNG/JPG)

Certains documents n'existent qu'en capture d'écran (ex. confirmation
Hostelworld sans PDF). Le bouton d'import accepte indifféremment PDF et
images (`accept="application/pdf,image/*"`) et détecte automatiquement le
type de fichier sélectionné :

- **PDF** → flux habituel (extraction + pré-remplissage automatique).
- **Image** → pas d'extraction de texte : l'image s'affiche en grand
  au-dessus d'un formulaire vide, pour recopier les infos rapidement sans
  changer d'écran. L'image est stockée comme un PDF (même `pdfBlob` en
  IndexedDB) et reste consultable ensuite via le bouton **« Voir
  l'original »** sur la carte de l'entrée.

### Géolocalisation — bouton 📍 « Y aller »

Une entrée avec une **adresse** renseignée (détectée automatiquement ou
saisie à la main) affiche un bouton 📍 sur sa carte (onglets Entrées et
Planning). Il ouvre l'app de navigation du téléphone avec l'adresse
pré-remplie, sans carte intégrée ni clé API :

- iOS (détecté via `navigator.userAgent`) → `maps.apple.com` (ouvre Plans).
- Android / autres → `google.com/maps/search` (ouvre Google Maps ou le
  navigateur si l'app n'est pas installée).

Aucune adresse renseignée → le bouton n'apparaît pas. Si l'entrée a en plus
des **coordonnées GPS** (voir « Enregistrer ma position ici » ci-dessous),
le lien utilise les coordonnées exactes plutôt que l'adresse texte, plus
précis notamment pour un lieu sans adresse postale claire.

#### Coordonnées GPS — « Enregistrer ma position ici »

Pas de géocodage automatique de l'adresse : ça demanderait un service en
ligne (Nominatim, Google Geocoding...), incompatible avec le fonctionnement
100% hors-ligne et sans clé API de l'app. À la place, le formulaire d'une
entrée propose un bouton **« 📍 Enregistrer ma position ici »** qui capture
la position GPS actuelle du téléphone (`navigator.geolocation`) — utile
quand tu es sur place (ou que tu la retrouves via une autre app de plans) et
que tu veux la mémoriser pour cette entrée. Optionnel : sans coordonnées,
tout continue de fonctionner comme avant (adresse texte pour le bouton 📍,
pas d'estimation de trajet — voir plus bas).

### Planning : vue "Aujourd'hui", ouverture directe, plage horaire, trajet estimé

**Vue "Aujourd'hui" épinglée** en haut de l'onglet Planning : uniquement les
entrées dont la date correspond à la date calendaire du jour (comparée à
l'horloge du téléphone), triées par heure — accès immédiat sans avoir à
chercher dans le planning complet en dessous. Rien de prévu aujourd'hui →
message « Rien de prévu aujourd'hui » à la place. Ouvrir un voyage qui a au
moins une entrée aujourd'hui atterrit directement sur l'onglet Planning
(sinon comportement inchangé : onglet Entrées par défaut).

Chaque élément du Planning est cliquable et ouvre **directement** le PDF/l'image
d'origine (viewer natif, ou plein écran pour une image) sans passer par
l'onglet Entrées — l'entrée sans pièce jointe ouvre l'édition à la place. Un
bouton ✎ séparé permet aussi de modifier l'entrée directement.

Quand une entrée a une heure de fin (`endTime`), les deux heures s'affichent
en évidence (`18:00 → 19:30`).

**Temps de trajet estimé entre deux entrées consécutives.** Si les deux ont
des coordonnées GPS, la distance à vol d'oiseau entre les deux points est
calculée (formule de Haversine) et convertie en temps de trajet estimé selon
un mode par défaut : **à pied** en dessous de 2 km (5 km/h), **en transport
en commun** au-delà (25 km/h + un forfait fixe de 10 min de marche
d'approche/attente) — le mode utilisé est affiché à côté du temps
(`🚶 12 min de marche estimée`, `🚇 ~35 min en transport estimé`), suivi de
la marge restante une fois ce trajet effectué (`· 45 min de marge`). Si le
trajet estimé dépasse le temps disponible, la carte est signalée
visuellement (bordure rouge + ⚠️) comme risque de retard. Une mention
discrète rappelle que c'est une estimation à vol d'oiseau, pas un vrai
calcul d'itinéraire routier (aucune clé API, fonctionne hors-ligne).

**Sans coordonnées GPS sur l'une des deux entrées** (le cas de la plupart
des entrées existantes, ou de toute adresse jamais géolocalisée) → simple
calcul de différence d'heures, comme avant (`⏳ 30 min avant le prochain
événement`).

### QR code / code-barres en plein écran — « Afficher pour scan »

Toute carte de document avec un PDF/une image joint (Entrées, billet
combiné) a un bouton **🔳 Afficher pour scan** : ouvre le document en plein
écran sur fond blanc (rendu de la 1ère page en image pour un PDF, via
pdf.js) pour faciliter la lecture du QR code/code-barres par un tiers
(contrôleur, portique...). Un **Wake Lock** (`navigator.wakeLock`) est
demandé pendant l'affichage pour empêcher la mise en veille de l'écran ;
si le navigateur ne le supporte pas, ou pour la luminosité (qu'aucune API
web standard ne permet de forcer), un message invite explicitement à
l'augmenter à la main.

### Rappels avant chaque événement

Réglages accessibles via l'icône ⚙️ sur l'écran d'accueil : activer les
rappels + délai par défaut (30 min par défaut, modifiable). Chaque entrée
peut aussi avoir son propre réglage (`Réglage par défaut` / `Délai
personnalisé` / `Aucun rappel`) dans son formulaire.

La permission de notification n'est demandée **qu'au moment où tu actives
les rappels** dans les réglages — jamais au premier lancement de l'app.

**Comment ça marche techniquement** (`js/reminders.js`) : à chaque
modification d'entrée, l'app recalcule tous les rappels à venir (tous
voyages confondus) et programme un `setTimeout` par rappel ; à l'échéance,
`ServiceWorkerRegistration.showNotification()` affiche la notification.

**Limite technique importante — pas de rappels fiables app fermée sans
backend.** Un vrai système de notifications programmées qui se déclenchent
même app fermée nécessite le **Web Push API** : un serveur qui envoie la
notification au bon moment via un service de push (VAPID). Voyag'heure est
volontairement 100% locale, sans backend — donc :

- **Android/Chrome** : fonctionne bien tant que Chrome tourne encore en
  arrière-plan (app pas tuée depuis les apps récentes, téléphone pas
  redémarré). Le `setTimeout` survit à un onglet en arrière-plan mais pas à
  la fermeture du navigateur.
- **iOS/Safari** : très limité. iOS suspend le processus de la PWA dès
  qu'elle n'est plus au premier plan — le rappel ne se déclenche que si tu
  as Voyag'heure ouverte à l'écran au moment voulu. C'est une limite d'iOS,
  pas un bug : impossible à contourner sans serveur de push (ce qui
  changerait l'architecture 100% locale de l'app). Un rappel indicatif à
  cet effet s'affiche dans les réglages sur iOS.

En pratique : utile comme pense-bête si tu gardes l'app ouverte (ou le
téléphone déverrouillé dessus) à l'approche d'un événement, mais ne t'y fie
pas pour un rappel qui doit sonner à coup sûr téléphone en poche.

## Checklist de voyage

Onglet dédié par voyage, indépendant du Planning et des Entrées : une
liste simple à cocher, texte libre, ajoutée/supprimée par l'utilisateur.
Aucun contenu suggéré automatiquement — une liste vide au départ.

## Sauvegarde — export / import

Réglages (icône ⚙️ sur l'écran d'accueil) → **Exporter mes données** :
génère un fichier JSON contenant l'intégralité des données stockées (tous
les voyages, entrées, billets combinés et checklists — PDF et photos
compris, encodés en base64) et propose son partage via l'**API Web Share**
si le navigateur la supporte, sinon un téléchargement classique.

**Importer une sauvegarde** accepte ce même format JSON et restaure les
données, avec deux confirmations explicites avant toute écriture :
d'abord confirmer l'import lui-même, puis choisir entre **remplacer**
toutes les données actuelles ou **fusionner** (garder aussi les voyages
déjà présents sur l'appareil — les identifiants d'origine de la sauvegarde
sont conservés, donc réimporter deux fois la même sauvegarde en mode
fusion ne duplique rien).

Utile pour changer de téléphone, ou simplement garder une copie de
sécurité — tout reste un fichier local, aucune donnée n'est envoyée à un
serveur.

## Développement local

Aucune dépendance à installer pour faire tourner l'app. Il faut juste la
servir en HTTP (les Service Workers et les modules ES ne fonctionnent pas
sur `file://`) :

```bash
python3 -m http.server 8080
# puis ouvrir http://localhost:8080/index.html
```

Pour régénérer les icônes après un changement de palette :

```bash
node scripts/generate-icons.js
```

pdf.js est vendored dans `vendor/pdfjs/` (voir `vendor/pdfjs/LICENSE`) —
aucune installation npm n'est nécessaire pour lancer l'app. Pour mettre à
jour la version vendored :

```bash
npm install pdfjs-dist@<version> --no-save --prefix /tmp/pdfjs-update
cp /tmp/pdfjs-update/node_modules/pdfjs-dist/legacy/build/pdf.min.mjs vendor/pdfjs/
cp /tmp/pdfjs-update/node_modules/pdfjs-dist/legacy/build/pdf.worker.min.mjs vendor/pdfjs/
```

## Installer sur Android (une fois l'app déployée en ligne)

L'app doit être servie en **HTTPS** (ex. GitHub Pages, Netlify, Vercel...) —
un Service Worker ne s'installe pas sur une page HTTP simple (sauf
`localhost`).

1. Ouvre le lien de la PWA dans **Chrome** sur ton téléphone Android.
2. Un bandeau **« 📲 Installer Voyag'heure sur l'écran d'accueil »** apparaît
   en haut de l'app — appuie dessus, puis confirme **« Installer »**.
   - Si le bandeau n'apparaît pas : menu **⋮** (en haut à droite de Chrome)
     → **« Installer l'application »** (ou **« Ajouter à l'écran d'accueil »**).
3. L'icône **Voyag'heure** apparaît sur ton écran d'accueil et s'ouvre en
   plein écran, sans barre d'adresse.
4. **Avant de partir**, ouvre l'app une première fois avec du réseau (Wi-Fi
   ou 4G), crée ton voyage et **importe tes PDF**. C'est ce premier
   chargement qui met en cache l'app (y compris pdf.js) pour l'usage
   hors-ligne.
5. Ensuite, l'app fonctionne **entièrement sans connexion** : tu peux couper
   le Wi-Fi/données mobiles et retrouver tes voyages, tes billets, ton
   planning et ton budget normalement — importer un nouveau PDF fonctionne
   même hors-ligne, puisque pdf.js est lui aussi mis en cache.

### Astuce

Un badge **« Hors-ligne »** apparaît en haut de l'app dès que le téléphone
n'a plus de connexion, pour confirmer que le mode local fonctionne.

## Notes de conception

- Les PDF sont ouverts via une `blob:` URL dans un nouvel onglet : c'est le
  viewer PDF natif du navigateur qui prend le relais en plein écran.
- Chaque entrée peut être modifiée ou supprimée après coup (onglet Entrées,
  ou directement depuis une ligne du Planning/Budget).
- Supprimer un voyage supprime aussi toutes ses entrées (et les PDF associés).
- Largeur : `#app` remplit 100% de la largeur jusqu'à 560px (bien au-delà des
  largeurs de viewport réelles d'un téléphone, y compris les Android réglés
  sur un niveau de zoom d'affichage réduit, qui élargit le viewport CSS) ; le
  rendu "carte centrée" avec ombre ne s'applique qu'à partir de 768px
  (desktop). Avant ce correctif, un `max-width: 420px` trop strict pouvait
  laisser des bandes vides sur certains Android.
