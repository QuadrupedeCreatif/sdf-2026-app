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
| `price` | Montant en € (optionnel) |
| `reference` | Référence / numéro de commande |
| `paymentStatus` | `paid` (déjà payé) / `due` (à venir) / `estimate` (estimé) |
| `reminderMode` | `default` (réglage global) / `custom` (voir `reminderMinutes`) / `none` |
| `reminderMinutes` | Délai personnalisé en minutes, utilisé seulement si `reminderMode: 'custom'` |
| `pdfBlob` | Le fichier original (`Blob`, PDF **ou image**), absent pour une entrée ajoutée à la main |

Le Planning et le Budget sont **entièrement dérivés** de ces entrées : aucune
donnée de planning/budget n'est stockée séparément.

## Import intelligent

Import d'un ou plusieurs PDF → `js/parser.js` reconstruit d'abord les
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
- **Prix** : `24,00 €`, `€ 24,00`, `24,00 EUR`, en priorité sur une ligne
  contenant "Total"/"Prix"/"Montant" — un montant labellisé
  "sous-total"/"partiel" passe après les autres par défaut.
- **Lieu** : libellés lieu/venue/destination/départ/arrivée, en écartant
  les candidats qui ressemblent à une date plutôt qu'à un lieu.
- **Adresse** : une ligne « code postal + ville » (`75012 Paris`,
  `1013 AK Amsterdam`...) combinée à la ligne précédente si elle ressemble
  à un nom de rue.
- **Référence** : libellés référence/commande/réservation/booking/
  confirmation suivis d'un code.

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

Aucune adresse renseignée → le bouton n'apparaît pas.

### Planning : ouverture directe, plage horaire, temps de battement

Chaque élément du Planning est cliquable et ouvre **directement** le PDF/l'image
d'origine (viewer natif, ou plein écran pour une image) sans passer par
l'onglet Entrées — l'entrée sans pièce jointe ouvre l'édition à la place. Un
bouton ✎ séparé permet aussi de modifier l'entrée directement.

Quand une entrée a une heure de fin (`endTime`), les deux heures s'affichent
en évidence (`18:00 → 19:30`). Entre deux entrées consécutives d'un même
jour, si les deux ont une heure, le temps libre entre la fin de la première
(ou son heure de début si pas d'heure de fin) et le début de la suivante est
calculé et affiché (`⏳ 30 min avant le prochain événement`) — un simple
calcul de différence, pas un itinéraire réel.

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
