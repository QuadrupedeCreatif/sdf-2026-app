# SDF 2026 — PWA billets de voyage

PWA mobile installable pour gérer hors-ligne les billets et le séjour au
festival **Summer Dance Forever 2026** (Paradiso, Amsterdam, 28→31 août) :
3 billets festival, 2 trajets FlixBus, 1 réservation Hostelworld.

Tout est **100% local** : les PDF sont stockés dans IndexedDB, le planning et
le budget dans localStorage. Rien n'est envoyé sur un serveur — il n'y a
d'ailleurs pas de backend.

## Structure

```
index.html          Écran unique (onglets Documents / Planning / Budget)
manifest.json        Manifeste PWA (nom, icônes, couleurs)
sw.js                 Service Worker (cache app-shell pour l'usage hors-ligne)
css/style.css         Styles (mobile-first, ~380px, palette festival)
js/db.js              Wrapper IndexedDB pour les fichiers PDF
js/data.js             Données planning/budget + persistance localStorage
js/app.js              Logique de l'app (onglets, import, rendu, install)
icons/                 Icônes PNG générées par scripts/generate-icons.js
scripts/generate-icons.js  Générateur d'icônes (sans dépendance externe)
```

## Développement local

Aucune dépendance à installer. Il faut juste servir les fichiers en HTTP
(les Service Workers ne fonctionnent pas sur `file://`) :

```bash
python3 -m http.server 8080
# puis ouvrir http://localhost:8080/index.html
```

Pour régénérer les icônes après un changement de palette :

```bash
node scripts/generate-icons.js
```

## Installer sur Android (une fois l'app déployée en ligne)

L'app doit être servie en **HTTPS** (ex. GitHub Pages, Netlify, Vercel...) —
un Service Worker ne s'installe pas sur une page HTTP simple (sauf
`localhost`).

1. Ouvre le lien de la PWA dans **Chrome** sur ton téléphone Android.
2. Attends quelques secondes : un bandeau **« 📲 Installer SDF 2026 sur
   l'écran d'accueil »** apparaît en haut de l'app — appuie dessus, puis
   confirme **« Installer »** dans la fenêtre proposée par Chrome.
   - Si le bandeau n'apparaît pas : ouvre le menu **⋮** (trois points, en
     haut à droite de Chrome) → **« Installer l'application »** (ou
     **« Ajouter à l'écran d'accueil »**).
3. L'icône **SDF 2026** apparaît sur ton écran d'accueil, comme une vraie
   app. Elle s'ouvre en plein écran (sans barre d'adresse).
4. **Avant de partir**, ouvre l'app une première fois avec du réseau (Wi-Fi
   ou 4G) et **importe tous tes PDF** (billets festival, billets FlixBus,
   confirmation Hostelworld) via le bouton **« + Importer des PDF »** de
   l'onglet Documents. C'est ce premier chargement qui met en cache les
   polices et le code de l'app pour l'usage hors-ligne.
5. Une fois les documents importés, l'app fonctionne **entièrement sans
   connexion** : tu peux couper le Wi-Fi/données mobiles (utile en avion,
   en bus ou en itinérance à l'étranger) et retrouver tes billets, ton
   planning et ton budget normalement.

### Astuce

Un badge **« Hors-ligne »** apparaît en haut de l'app dès que le téléphone
n'a plus de connexion, pour confirmer que le mode local fonctionne.

## Notes de conception

- Les PDF sont ouverts via une `blob:` URL dans un nouvel onglet : c'est le
  viewer PDF natif du navigateur (celui utilisé aussi par les vraies apps)
  qui prend le relais en plein écran.
- Le planning est un contenu de départ indicatif : les horaires précis sont
  volontairement marqués « à vérifier sur le billet », faute de disposer
  des billets réels au moment de la génération de l'app.
- Le budget est entièrement éditable (libellés et montants) et sépare
  Déjà payé / À venir / Estimé, avec un total en un coup d'œil.
