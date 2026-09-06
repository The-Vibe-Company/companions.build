# Preuve Pi/Bun sur Linux — 6 septembre 2026

## Verdict

**Continuer avec Pi SDK et Bun.** La distribution expérimentale fonctionne sous
Linux x86_64 sans installation de dépendances au lancement. Onze tests passent
avec le vrai Pi, des fichiers et processus réels, un modèle scripté et des
serveurs MCP de test. TypeScript passe également sa vérification.

La distribution retenue pour cette preuve est un **binaire accompagné de ses
ressources figées**. Le WASM de Photon est nécessaire au redimensionnement des
images. Chercher à tout enfermer dans un fichier unique n'est pas nécessaire
pour supprimer les installations au réveil.

Cette conclusion valide la faisabilité locale du programme. Elle ne valide pas
encore l'application, le réveil chez Box, la supervision système ou la fiabilité
du futur protocole entre l'application et la Box.

## Reproduire et examiner

Depuis la racine du nouveau dépôt, Python 3 et Docker démarré :

```sh
python3 experiments/pi-bun/verify.py
```

Le script télécharge Bun 1.4.2 dans son cache local et vérifie la somme SHA-256
publiée pour cette version. L'installation de build utilise `bun.lock` gelé,
sans scripts post-installation. Il compile la cible `bun-linux-x64-baseline`,
construit le conteneur de test et lance les tests. Aucun outil système global
n'est remplacé. La première préparation requiert Internet ; les scénarios
d'exécution sont isolés avec `--network=none` et n'ont aucune clé fournisseur.

Run de référence : `20260906T182904Z-2647def8`. Vérification complète : **51,9 s**,
dont **40,9 s** pour les 11 tests et les dix échantillons de démarrage. Cette durée
inclut un cache de dépendances et une image Debian déjà disponibles ; ce n'est
pas une mesure de première installation sur une machine vierge.

- [Mesures brutes, commandes, versions et inventaire SHA-256](../measurements/pi-bun-2026-09-06.json).
- [Tests de comportement](../../experiments/pi-bun/acceptance.test.ts).
- [Programme expérimental](../../experiments/pi-bun/main.ts).
- [Construction de la distribution](../../experiments/pi-bun/build.ts).
- [Commande de validation](../../experiments/pi-bun/verify.py).

Chaque run conserve ses logs, transcriptions JSON, disques de test, mesures et
archive sous `.artifacts/pi-bun/<run>/`. Un échec renvoie un code non nul et
indique le log à lire. Le dossier `manual/` conserve aussi les traces locales
des étapes de développement rouge/vert. Les traces contiennent seulement les
données synthétiques de cette expérience ; ce format n'est pas une politique
de journalisation de données client.

## Environnement et versions

Hôte : macOS arm64, Darwin 25.6.0. Docker Engine 29.3.1, Linux x86_64 émulé.
Conteneur : Debian 12 glibc, image épinglée par digest dans le Dockerfile.
Le disque racine est en lecture seule, les sorties persistantes ont leur montage
propre, les capacités Linux sont retirées et aucun port n'est publié.

| Élément | Version |
| --- | --- |
| Pi coding-agent, pi-ai et famille de paquets Pi | 0.85.0 |
| Bun de build et runtime embarqué | 1.4.2 |
| SDK MCP TypeScript | 1.27.1 |
| Photon | 0.3.4 |
| TypeScript | 5.9.3 |

Les dépendances transitives sont fixées par le lockfile. Les paquets Pi ont
également des overrides explicites pour éviter le mélange 0.85.0/0.85.1 observé
pendant la première installation.

## Comportements observés

| Promesse testée | Preuve observable |
| --- | --- |
| Démarrer sans installation | Le binaire répond dans Linux sans Node, Bun, npm, pnpm, yarn, apt ou dpkg disponibles ; réseau extérieur coupé |
| Outils Pi réels | Pi écrit un fichier, le relit et le modèle scripté vérifie le résultat de l'outil |
| Chat indépendant | Le chat répond pendant un vrai shell actif dans la session de fond ; leurs historiques restent distincts |
| Annuler | Annulation après création du marqueur de début ; l'effet prévu après le délai shell ne se produit pas |
| Comportement natif pendant le travail | `prompt(..., streamingBehavior: "steer")` accepte la nouvelle instruction ; le shell termine et Pi utilise ensuite cette instruction |
| Persistance | Un nouveau processus retrouve les deux historiques et relit le fichier depuis le disque conservé |
| Coupure après effet externe | Conteneur tué après l'écriture, avant la fin de l'outil ; au retour, pas de relance automatique, effet présent une seule fois, nouvelle demande exécutable |
| Skill | Pi charge `/skill:probe-skill` et son script shell relatif retourne la valeur attendue |
| MCP stdio | Le client initialise un serveur compilé séparément, découvre son outil et l'appelle via stdio |
| MCP HTTP | Le client initialise le serveur local via Streamable HTTP, découvre l'outil et reçoit sa réponse |
| Image | Pi lit une image PNG 2200 × 1200 ; le modèle reçoit réellement une image 2000 × 1091 |

Le double du modèle remplace uniquement le fournisseur : il émet des réponses
et appels d'outils déterministes, puis examine les vrais résultats reçus. Il ne
remplace ni la boucle Pi, ni ses outils, ni son gestionnaire de sessions. Les
essais ne mesurent donc pas la qualité d'un modèle ni sa latence réseau.

## Démarrage : dix mesures

Tous les échantillons utilisent un processus et un disque de session neufs,
sur le même moteur Docker déjà démarré. Le cache système et les pages du binaire
peuvent être chauds. Le polling du pilote de test a une résolution de 10 ms.

| Mesure | Médiane | Maximum observé |
| --- | ---: | ---: |
| Uptime du processus lorsqu'il annonce être prêt | 1 351 ms | 1 432 ms |
| Appel Docker → réception de l'état prêt | 1 472 ms | 1 557 ms |
| Initialisation après les imports JS | 272 ms | 296 ms |
| Envoi → admission observée | 11 ms | 22 ms |
| Envoi → réponse finale du modèle scripté | 21 ms | 33 ms |

La cible locale de deux secondes pour un ordinateur déjà disponible est atteinte
sur cet échantillon. Aucune extrapolation de ces chiffres à la création ou au
réveil d'une Box : ils ne comprennent pas l'API du fournisseur, la restauration
de snapshot, la supervision ou les connexions réelles aux plugins. Les connexions
MCP de cette expérience sont ouvertes au premier appel d'outil et ne font pas
partie de l'état prêt.

## Adaptations nécessaires trouvées par les essais

1. **Bun 1.3.5 → 1.4.2.** Dans cet essai Linux, le programme compilé avec le Bun
   global 1.3.5 annonçait son état prêt puis quittait avant de traiter une commande.
   La même intégration avec 1.4.2 passe. La cause interne à Bun n'a pas été isolée ;
   ce résultat justifie le pin et le test de lancement, pas une conclusion sur
   toutes les applications Bun 1.3.5.
2. **Paquet Pi supplémentaire au build.** L'import du SDK traverse un module
   expérimental qui importe `@earendil-works/pi-server`, absent des dépendances
   déclarées de coding-agent 0.85.0. L'ajouter explicitement en 0.85.0 débloque le
   bundling. L'expérience n'utilise pas ce serveur comme protocole produit.
3. **Photon WASM.** Sans `photon_rs_bg.wasm`, le binaire fonctionnait pour le texte
   mais le test d'image échouait. Livrer le fichier à côté de l'exécutable permet
   le redimensionnement. Pi prévoit ce chemin de secours dans son chargeur Photon.

Le binaire Companion du run fait **92 812 768 octets (88,51 MiB)**. Le WASM fait
1 881 634 octets (1,79 MiB). `package.json` conserve la version Pi attendue par
son chargeur. Les skills restent des fichiers accompagnés de leurs ressources.
Le second exécutable `mcp-fixture` (78,23 MiB) et l'image PNG sont des fixtures
de test ; leur taille ne représente pas une dépendance du futur produit.

Sources de l'intégration : [SDK Pi 0.85.0](https://github.com/earendil-works/pi/blob/v0.85.0/packages/coding-agent/docs/sdk.md),
[chargeur Photon](https://github.com/earendil-works/pi/blob/v0.85.0/packages/coding-agent/src/utils/photon.ts),
[exécutables Bun](https://bun.com/docs/bundler/executables),
[release Bun 1.4.2](https://github.com/oven-sh/bun/releases/tag/bun-v1.4.2).

## Limites à conserver dans la suite

- L'admission, les résultats et les demandes en cours n'ont pas encore de journal
  produit durable. Le test de coupure démontre l'absence de relance automatique
  au démarrage ; il ne garantit pas un « exactement une fois » distribué. Un
  effet externe dont la réponse manque reste ambigu. La reprise d'historique Pi
  ne suffit pas à en connaître l'issue : le futur service doit l'afficher comme
  interrompu et conserver son identifiant sans le redispatcher automatiquement.
- Le test n'exerce pas le processus de supervision, un vrai arrêt/réveil Box,
  les snapshots, la promotion de templates ou un système de routines persistant.
- Le redimensionnement d'image est validé. Pi peut se rabattre sur un calcul dans
  le processus principal si son worker embarqué est introuvable ; l'exécution
  dans un worker et la réactivité pendant une grosse image ne sont pas prouvées.
- Skill Markdown avec script shell et MCP de test sont couverts. Extensions JS
  arbitraires, serveurs MCP nécessitant leur propre Node/Python, OAuth et les
  cinq plugins réels restent à exercer. Un binaire autonome ne fournit pas les
  runtimes requis par tous les outils tiers.
- Compaction, reprise de stream réel, mémoire partagée, concurrence sur un même
  fichier et persistance résistante à une panne matérielle restent hors de cette
  preuve. Les tests de coupure portent sur le processus/conteneur avec disque
  conservé, pas sur une perte d'alimentation du stockage.

## Décision pour le développement

Conserver Pi SDK, Bun 1.4.2 et une distribution versionnée préinstallée dans le
template. Ne pas reconstruire le harness. Garder la frontière de test au programme
exécutable, avec modèle et fournisseurs de test remplaçables.

La prochaine tranche produit doit relier un écran de chat minimal à un travail
persisté : l'application accepte une demande, le programme l'exécute et le résultat
reste visible après redémarrage. Puis ajouter une routine au même parcours en
gardant le chat disponible. Cette tranche doit fixer le transport et le journal
durable que l'expérience n'a volontairement pas inventés.
