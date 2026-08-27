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
js/db.js                   IndexedDB : stores "trips" et "entries"
js/parser.js                Extraction de texte PDF (pdf.js) + heuristiques
                            de détection (type, dates, heure, prix, lieu,
                            référence)
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
| `endDate` | Date de fin (optionnelle, ex. check-out d'un hôtel) |
| `place` | Lieu (nom du venue/gare/hôtel) |
| `address` | Adresse postale libre (rue, ville, code postal) — sert au bouton 📍 |
| `price` | Montant en € (optionnel) |
| `reference` | Référence / numéro de commande |
| `paymentStatus` | `paid` (déjà payé) / `due` (à venir) / `estimate` (estimé) |
| `pdfBlob` | Le fichier original (`Blob`, PDF **ou image**), absent pour une entrée ajoutée à la main |

Le Planning et le Budget sont **entièrement dérivés** de ces entrées : aucune
donnée de planning/budget n'est stockée séparément.

## Import intelligent

Import d'un ou plusieurs PDF → `js/parser.js` extrait le texte avec **pdf.js**
(reconstruit les lignes à partir de la position des fragments de texte, pdf.js
ne les fournit pas nativement) puis applique des heuristiques :

- **Type** : mots-clés transport (FlixBus, SNCF, gare, aéroport, vol...),
  hébergement (hostel, hôtel, Booking.com, Airbnb, check-in/out...), sinon
  billet événement par défaut.
- **Dates** : formats `JJ.MM.AAAA`, `JJ/MM/AAAA`, et dates en toutes lettres
  (`28 août 2026`, mois abrégés). La première date trouvée devient la date de
  début, la dernière (si différente) la date de fin.
- **Heure** : formats `14:30` ou `14h30`.
- **Prix** : motifs `XX,XX €` ou `XX EUR`, en priorité sur une ligne
  contenant "total".
- **Lieu** : recherche de libellés (lieu, adresse, départ, arrivée...) en
  écartant les candidats qui ressemblent à une date plutôt qu'à un lieu.
- **Adresse** : recherche une ligne « code postal + ville » (`75012 Paris`,
  `1013 AK Amsterdam`...) et la combine avec la ligne précédente si elle
  ressemble à un nom de rue.
- **Référence** : recherche de libellés (référence, commande, réservation,
  booking, confirmation...) suivis d'un code.

Le formulaire de confirmation est **toujours** pré-rempli avec ces valeurs :
l'utilisateur valide ou corrige, il ne saisit jamais un billet depuis zéro.
Ces heuristiques sont un pré-remplissage, pas une garantie — un PDF scanné
(image) ou une mise en page inhabituelle peut ne rien détecter ; le
formulaire reste alors éditable normalement.

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
