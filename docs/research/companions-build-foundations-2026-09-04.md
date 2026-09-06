# companions.build — repartir de zéro avec les apprentissages de Companion

> Notes exploratoires conservées comme historique. Depuis le 5 septembre 2026, le
> [cadrage produit consolidé](../companions-build.md) est la référence à lire et à mettre à jour.

Date : 4 septembre 2026. État : cadrage proposé, pas une spécification approuvée.
Source locale examinée : Companion à `8d000e5a`. Inspection statique et historique Git ;
aucun benchmark ni diagnostic de production effectué pendant cette étude.

## Ce que Stan a fixé

- Nouveau produit open source, décrit comme un « Grok bot » optimisé.
- Nouveau départ : le dépôt actuel transmet ses apprentissages, pas son architecture.
- Pas d'archéologie supplémentaire : l'historique `companion-v2` existe mais Stan ne souhaite pas
  en faire un préalable. Les exemples ci-dessous étaient déjà examinés lors de cette précision.
- Des Companions faciles à créer, avec ordinateur persistant, MCP, plugins, routines et triggers.
- box.ascii.dev conservé ; choix du moteur d'agent à réexaminer.
- Aucune intégration Skills Hub pour l'instant.
- Web uniquement, design très pur et simple, projet techniquement compact.
- Un seul chat actif par Companion à la fois. Une routine ne doit pas faire attendre la réponse
  au chat : leurs exécutions doivent pouvoir progresser indépendamment.
- Objectif exprimé : agent prêt en quelques secondes sur Box, contre parfois une minute auparavant.
  Distinguer temps de lancement de l'agent, création/réveil fournisseur et première réponse modèle.
- Cadrage validé par Stan : runtime figé et préinstallé, démarrage automatique, aucune installation
  des dépendances du runtime ni mise à jour au réveil ; chat dans une session persistante et chaque
  routine dans une session distincte. Une seule routine active à la fois ; les suivantes attendent.
- Critère accepté pour le prototype : sur une Box disponible, l'agent doit accepter une tâche en
  moins de deux secondes après lancement. Création/réveil complet en quelques secondes reste un
  objectif à mesurer avec Box. Le chat doit progresser pendant une routine longue. Ces objectifs
  ne sont pas des résultats de benchmark.
- Comptes personnels indépendants validés, chacun avec ses Companions et connexions.
- Cas d'usage ajouté : préparer un Companion, y installer des skills, puis le fournir à un client
  qui prend en charge les serveurs et les autres coûts. L'installation de skills sur la Box ne
  nécessite pas l'intégration au Skills Hub exclue du périmètre. Propriété et accès du prestataire
  après livraison restent à décider.
- Facturation validée : le client souscrit à companions.build, qui porte la relation avec Box et
  les fournisseurs de modèles. L'abonnement comporte une facturation à l'usage ; allocation incluse,
  unités, tarifs et plafonds restent à définir. Le client ne paie pas directement ces fournisseurs.
- Communication et délégation entre Companions explicitement dans le périmètre.
- Réplication demandée : créer un agent spécialisé, par exemple de coding, puis autoriser un
  Companion à en lancer des réplicats pour une tâche jusqu'à un maximum configuré. Les réplicats
  disparaissent après leur tâche. Périmètre du maximum, emplacement et héritage des accès restent
  à définir.
- Amélioration des templates demandée : un enfant peut proposer une modification issue de son
  travail (par exemple une dépendance installée) ; le parent décide de l'intégrer au template pour
  les prochains enfants. La proposition doit être conservée avant la suppression du réplicat.
- Simplification explicitement choisie : le parent peut promouvoir la Box de l'enfant comme futur
  template via un snapshot, sans reconstruire l'environnement à partir d'une recette d'installation.
  Ce parcours suppose une Box propre au réplicat promu ; une session sur une Box partagée ne permet
  pas de capturer uniquement l'environnement de cet enfant.
- Triggers précisés : réception de webhooks (exemples : CI en échec sur main, nouvelle issue Sentry),
  avec déclenchement direct ou validation préalable par code. Aucun appel LLM pour décider si un
  événement filtrable par code mérite une tâche. Le filtre doit précéder le réveil de la Box.
- Bureau interactif demandé : l'utilisateur peut ouvrir et manipuler le bureau de la Box pour
  installer des logiciels et connecter des comptes. Le transfert temporaire du contrôle visuel
  entre humain et agent est à concevoir.
- Configuration intégralement pilotable par l'agent via un MCP de contrôle produit, explicitement
  demandée par Stan. Interface web et agent utilisent les mêmes opérations et la même configuration.
  Les opérations de configuration ne doivent pas exister uniquement dans l'interface web.
- Priorité : création rapide, réveil fiable, routines qui partent réellement, travail qui ne reste
  pas bloqué. Stan rapporte de nombreux correctifs de stabilité, environ cinquante PR.
- Orientation de la discussion : Stan souhaite maintenant parler fonctionnalités produit. Détails
  des plafonds, facturation et gouvernance différés ; les recommandations proposées sur ces points
  ne sont pas des décisions acceptées et ne doivent pas bloquer l'exploration fonctionnelle.

« Grok bot » est une direction produit, pas encore une liste de fonctionnalités. Voix, applications
natives et groupes ne sont donc pas implicitement requis. Les exclusions historiques
du produit Skills Hub ne constituent pas non plus les décisions du nouveau produit.

## Le constat qui guide la refonte

Le problème observé traverse le cycle de vie, l'ordonnancement, les permissions et la restitution
des résultats. Changer Pi seul ne traite pas ces différentes causes.

L'historique fournit des cas concrets, déjà corrigés dans le dépôt actuel :

| Correctif | Défaut documenté ou visible dans le diff | Apprentissage pour le nouveau projet |
| --- | --- | --- |
| [Réveil fiable, #743](https://github.com/The-Vibe-Company/companion/pull/743), `8dc7e8a0` | Préparation lente bloquant les autres Companions ; leases expirant pendant un démarrage normal ; budgets de démarrage incompatibles | Une machine lente ne bloque pas les autres ; délais et renouvellement doivent être testés ensemble |
| [Retry routines, #739](https://github.com/The-Vibe-Company/companion/pull/739), `2c93c2b7` | Une identité de lancement réutilisée restait frappée par son marqueur d'annulation | Distinguer l'occurrence métier de ses tentatives techniques ; recommencer seulement après preuve de non-exécution |
| [Création et progression, #737](https://github.com/The-Vibe-Company/companion/pull/737), `1045e671` | Santé du runtime trop stricte pendant une longue opération ; état terminal non propagé au cache du chat ; préparation d'image fragile | Séparer santé du processus, état d'un travail et affichage ; tester le parcours complet |
| [Réponses terminales, #732](https://github.com/The-Vibe-Company/companion/pull/732), `ae4e056c` | Le texte final pouvait nécessiter une récupération depuis une autre enveloppe terminale Pi | Normaliser les événements à une seule interface et conserver un résultat final durable |
| [Credentials MCP, #740](https://github.com/The-Vibe-Company/companion/pull/740), `9456a9d8` | Les credentials préparés devaient être rechargés correctement | La rotation et le réveil doivent aboutir à des outils réellement utilisables |

Ces cas étayent un problème de coordination. Ils ne démontrent ni que Pi est intrinsèquement
instable, ni qu'une réécriture sera automatiquement plus rapide.

Le code actuel répartit cette coordination entre PostgreSQL, progression TypeScript, scripts de
préparation Box, broker Pi, journal local et projections clientes. Points d'entrée :

- [`production.ts`](https://github.com/The-Vibe-Company/companion/blob/8d000e5a1ff3d3d068c8e67b065b78b4a9f9c2e9/apps/runtime/src/production.ts) compose préparation, image builder,
  transports et exécution.
- [`progression.ts`](https://github.com/The-Vibe-Company/companion/blob/8d000e5a1ff3d3d068c8e67b065b78b4a9f9c2e9/packages/companion-runtime/src/v3/progression.ts) coordonne admission,
  autorisation, préparation, questions humaines, annulation et résultat.
- [`boxCompanionRuntime.ts`](https://github.com/The-Vibe-Company/companion/blob/8d000e5a1ff3d3d068c8e67b065b78b4a9f9c2e9/packages/box-runtime/src/boxCompanionRuntime.ts) mélange installation,
  instructions, fichiers, cycle de vie Pi et transports dans un fichier de 6 018 lignes.
- [`companionPiBrokerCore.ts`](https://github.com/The-Vibe-Company/companion/blob/8d000e5a1ff3d3d068c8e67b065b78b4a9f9c2e9/packages/box-runtime/src/companionPiBrokerCore.ts) possède un journal
  durable et un registre de dispatch : garanties utiles, coût d'intégration réel.
- [`CompanionsApp.tsx`](https://github.com/The-Vibe-Company/companion/blob/8d000e5a1ff3d3d068c8e67b065b78b4a9f9c2e9/apps/web/src/components/companions/CompanionsApp.tsx) lit le chat toutes
  les 3 secondes en activité et 8 secondes au repos. Cela peut retarder la visibilité du résultat ;
  ce n'est pas une mesure du temps de calcul du modèle.

La longueur d'un fichier indique ici où regarder ; elle n'est pas une preuve de mauvaise qualité.

## Garder les enseignements, reconstruire le code

| Garder comme promesse | Application dans le nouveau produit |
| --- | --- |
| Identité, fichiers et mémoire durables du Companion | Une Box dédiée ; redémarrage des processus attendu et vérifié |
| Travail accepté durablement avant exécution | Un identifiant stable par message ou occurrence ; état lisible après fermeture du navigateur |
| Routines et triggers | Deux sources du même mécanisme de travail ; un ordonnanceur extérieur à la Box peut la réveiller |
| Connexions consenties | Un modèle de connexion externe avec capacités outils/événements, permissions et révocation explicites |
| Zéro configuration webhook manuelle quand les credentials le permettent | Adaptateurs fournisseur qui enregistrent et réconcilient les hooks automatiquement |
| Pas de replay aveugle d'une action incertaine | Réconciliation par identifiant ; résultat « interrompu » si l'exécution reste indémontrable |
| Annulation, erreurs visibles et observabilité | Finir chaque travail dans un état compréhensible ; mesurer chaque étape |
| Tests avec PostgreSQL et vraie installation Linux | Reproduire les pannes historiques aux frontières où elles se produisent |

Références de savoir à consulter, sans copier les modules en bloc :

- Cron/fuseaux : [`companionRoutines.ts`](https://github.com/The-Vibe-Company/companion/blob/8d000e5a1ff3d3d068c8e67b065b78b4a9f9c2e9/packages/core/src/companionRoutines.ts).
- Déduplication : [`companionRoutineFireId.ts`](https://github.com/The-Vibe-Company/companion/blob/8d000e5a1ff3d3d068c8e67b065b78b4a9f9c2e9/packages/core/src/companionRoutineFireId.ts)
  et [`companionTriggerFireId.ts`](https://github.com/The-Vibe-Company/companion/blob/8d000e5a1ff3d3d068c8e67b065b78b4a9f9c2e9/packages/core/src/companionTriggerFireId.ts).
- Chiffrement : [`secretsCrypto.ts`](https://github.com/The-Vibe-Company/companion/blob/8d000e5a1ff3d3d068c8e67b065b78b4a9f9c2e9/packages/core/src/secretsCrypto.ts).
- OAuth et renouvellement : [`companionPluginOAuth.ts`](https://github.com/The-Vibe-Company/companion/blob/8d000e5a1ff3d3d068c8e67b065b78b4a9f9c2e9/packages/core/src/companionPluginOAuth.ts).
- Inscription et réconciliation webhook :
  [`companionTriggerWebhookRegistration.ts`](https://github.com/The-Vibe-Company/companion/blob/8d000e5a1ff3d3d068c8e67b065b78b4a9f9c2e9/packages/core/src/companionTriggerWebhookRegistration.ts).

Les règles fournisseur restent réelles : un compte MCP ne donne pas nécessairement les droits
d'inscription à des webhooks. Une « connexion » simple dans l'interface peut demander plusieurs
consentements ; elle ne doit pas promettre un scope que le fournisseur n'accorde pas.

## Ce que le nouveau dépôt n'hérite pas

- Bibliothèques Skills personnelles/org, versions, packages, publication, dépendances, miroirs
  GitHub, Agent Auth des clients Skills et Skill Databases.
- Migrations, purges et compatibilités des générations runtime précédentes.
- CRUD et schéma Companion existants : leur modèle porte encore sélection de Skills et permissions
  associées. [`materialPipeline.ts`](https://github.com/The-Vibe-Company/companion/blob/8d000e5a1ff3d3d068c8e67b065b78b4a9f9c2e9/apps/runtime/src/materialPipeline.ts) prépare toujours le
  skill embarqué et les credentials Hub.
- Applications iOS/macOS, distribution mobile et multiplication des contrats clients.
- Catalogue de modèles ou de moteurs exposé comme plateforme, marketplace d'extensions, workflow
  builder, tableaux d'administration avancés.
- Par défaut proposé : organisations/RBAC avancé, routines avec copie
  complète du contexte et sous-systèmes de mémoire isolés. Leur réintroduction doit répondre à un
  besoin concret ; l'isolation entre utilisateurs reste nécessaire si le service en accueille plusieurs.

Le choix « plugins + MCP » doit rester simple : **connexion** = autorisation d'un compte externe ;
**plugin** = intégration présentée à l'utilisateur, éventuellement composée d'outils MCP et de
triggers ; **MCP** = protocole technique utilisé pour les outils. Ce vocabulaire est proposé.

## Livraison, consommation et agents spécialisés

Le client dispose d'un abonnement companions.build avec consommation mesurée. Proposition : chaque
tâche garde son compte payeur, y compris lorsqu'elle délègue ou crée des exécutants. La plateforme
mesure séparément calcul Box et consommation modèle, puis applique ses règles tarifaires. Ne pas
fixer les tarifs sans mesures. Les accès et la consommation du prestataire pendant la préparation
ne sont pas automatiquement transférés au client ; le moment d'activation de la facturation et
la propriété après livraison restent à décider.

Vocabulaire proposé pour maintenir une distinction simple :

- **Companion** : agent persistant avec identité, ordinateur, mémoire et chat.
- **Profil d'agent** : configuration réutilisable d'un spécialiste (instructions, skills, modèle,
  outils autorisés). Un profil ne copie pas implicitement les secrets et conversations de son auteur.
- **Réplicat** : exécutant temporaire issu d'un profil, créé pour une tâche puis supprimé. Résultat,
  coût et éventuelles propositions d'amélioration survivent à son exécution.
- **Template d'agent** : proposition de nom pour le profil associé à un environnement logiciel
  préparé. La configuration de comportement et les dépendances installées restent distinctes
  dans son implémentation, même si le parent les voit comme un seul template.

Deux usages partagent la notion de tâche durable : déléguer à un Companion existant, ou confier
une tâche à un réplicat autorisé d'un profil. Les autorisations désignent les destinataires/profils
accessibles et limitent leurs ressources. Proposition initiale : maximum de réplicats simultanés
comptant aussi les créations en cours, budget et durée bornés, aucune réplication récursive. La
plateforme impose les plafonds, indépendamment des instructions du modèle. Un plafond de concurrence
seul ne limite pas une succession infinie de lancements.

Le partage des résultats doit être explicite. Autoriser une délégation n'autorise pas la lecture
de tout l'historique, ni l'utilisation de toutes les connexions du destinataire. Les communications
entre comptes clients restent une question ouverte ; commencer dans un même compte est proposé.
La promotion de la Box d'un enfant en template exige une Box dédiée à cet enfant. C'est donc la
direction retenue pour les réplicats pouvant être promus ; démarrage et coût restent à mesurer.
Cette capacité étend le socle initial et demande des tests de permissions, de limites et de reprise ;
elle n'est pas absorbée gratuitement par Pi.

### Amélioration d'un template par le parent

Comportement confirmé : les enfants proposent, le parent décide pour les prochains lancements.
Implémentation proposée : le parent dispose d'un droit explicite de modification sur le template
concerné ; ce droit est distinct du droit de lancer des réplicats. Il peut l'exercer de manière
autonome dans le budget et le périmètre accordés, sans confirmation humaine systématique.

Stan préfère une capture directe de la Box de l'enfant à une reconstruction propre par recettes.
L'enfant termine son travail et rend son résultat. Le parent peut choisir « utiliser sa Box comme
prochain template ». La plateforme conserve la Box le temps de cette décision et de la capture,
avec une rétention bornée à définir ; les résultats survivent indépendamment de la Box.

Proposition d'implémentation : terminer les processus de tâche, retirer l'identité d'exécution et
les credentials temporaires gérés par la plateforme, puis créer un snapshot nommé. Un clone de
validation vérifie démarrage et outils avant publication. Les fichiers utiles et logiciels installés
proviennent de la Box enfant ; le périmètre des fichiers à conserver doit être défini explicitement.
Des secrets écrits arbitrairement par les outils ne sont pas automatiquement identifiables : le
stockage et l'injection des credentials doivent être conçus pour ce mode de capture.

Publier une nouvelle version seulement lorsque le snapshot est prêt et les vérifications passent ;
la suppression de la Box source peut alors progresser sans supprimer le template. Conserver la
version précédente pour rollback. Les enfants actifs gardent leur environnement ; les suivants
partent de la nouvelle version. Sérialiser les promotions d'un même template et vérifier leur
version de départ pour éviter d'écraser une amélioration concurrente.

Installer un outil pendant une tâche reste possible. Sa conservation dans le snapshot évite de
le réinstaller au lancement suivant. La version précédente reste utilisable pendant la capture
et la validation ; un travail exigeant la nouvelle version attend sa publication explicitement.
Snapshot, rétention et validation sont imputés au compte payeur dans son budget. Le runtime de
plateforme reste versionné ; compatibilité de la Box promue et périmètre de modification autorisé
restent à valider dans le prototype. Les détails de nettoyage, validation et publication sont des
propositions techniques, distinctes du choix produit confirmé de capture directe.

## Proposition de socle compact

Un dépôt avec une application web et son backend, un worker durable et un petit programme supervisé
sur chaque Box. PostgreSQL conserve les utilisateurs, Companions, connexions, messages et travaux.
Le worker partage le code métier du backend ; il existe séparément pour survivre aux requêtes web.
Le programme Box porte le moteur d'agent choisi et expose un contrat réduit d'exécution.

```text
Web → backend → travail enregistré en PostgreSQL
                         ↑
                 routine ou webhook
                         ↓
                      worker → Box → moteur d'agent
                         ↓
               événements et résultat persistés → Web
```

Propositions à valider dans un prototype :

1. Un seul chemin pour envoyer une tâche, qu'elle vienne du chat, d'une routine ou d'un trigger.
   Un webhook filtré ne devient une tâche agent qu'après acceptation par le filtre en code ; la
   réception et l'évaluation du filtre se déroulent sans LLM et sans réveiller la Box du Companion.
2. L'ordonnanceur demeure actif hors des Boxes. Un cron exclusivement sur une machine arrêtée ne
   peut pas garantir son propre réveil.
3. Une version de runtime préinstallée dans un template Box, validée avant publication. Le parcours
   normal de création ne fait pas une nouvelle installation npm. Template indisponible : état
   explicite et retry borné ; ne pas improviser un second installateur complet dans le parcours.
4. Un transport normal unique vers le programme Box. Les commandes shell servent au bootstrap et
   au diagnostic ; elles ne forment pas un deuxième protocole quotidien à maintenir.
5. Une seule définition des transitions métier dans le code ; la base impose unicité, transactions
   et propriété du travail. Ne pas reconstruire deux moteurs de progression, en SQL et TypeScript.
6. Événements vers le navigateur avec reprise par curseur depuis les données persistées. SSE est
   une option à éprouver ; une connexion ouverte ne remplace pas le stockage durable.
7. Une seule autorité de retry par opération. L'idempotence du transport ne garantit pas l'exécution
   unique d'un effet externe : une coupure après un envoi d'email exige une preuve ou une interruption.

Ces éléments ne justifient pas un framework multi-moteurs, un bus distribué ou une multiplication
de packages. Stan a validé que les routines laissent le chat disponible : un programme
supervisé préinstallé, une session pour le chat et des sessions distinctes pour les routines, avec
au plus une routine active par Companion au départ. Les routines attendent entre elles. Les deux
types de travail partagent le mécanisme durable, sans partager un verrou tenu pendant toute leur
exécution. Limiter les ressources et définir la propriété des fichiers/mémoires partagés reste
nécessaire : deux sessions ne constituent pas une isolation système.

## Box : persistance et vitesse

Le fournisseur documente la reprise du même identifiant et du filesystem sur une nouvelle machine.
La mémoire, les processus et les ports ouverts ne survivent pas ; les services systemd activés
redémarrent. Un Companion persistant doit donc supporter un redémarrage normal de son agent.
[Source : Box snapshots](https://docs.ascii.dev/box/snapshots).

Les templates nommés permettent de préparer le runtime une fois avant de créer les Companions.
La vitesse annoncée par Box n'est pas un benchmark de notre produit : mesurer jusqu'à « premier
outil utilisable », avec renouvellement des accès, pas seulement jusqu'à « VM créée ».
[Source : Box templates](https://docs.ascii.dev/box/snapshots#template-boxes).

## Interface web proposée

Une liste discrète des Companions et une conversation centrale. Création : nom, consigne, connexions.
Une fiche compacte regroupe les outils et automatisations. Une routine affiche prochaine occurrence,
dernier résultat et activation ; un trigger affiche source, condition et dernier résultat.
L'activité donne des faits (« Démarrage », « Travail en cours », « Besoin de toi », « Terminé »).
Les termes lease, Pi, broker ou staging restent des diagnostics pour développeurs.

Palette neutre, typographie lisible, espace et peu de bordures. Les détails d'outils se déplient à la
demande. Aucun écran de flotte ou indicateur décoratif n'est nécessaire à cette première promesse.

## La preuve avant la généralisation

Premier prototype : créer → parler → routine → arrêter Box → réveiller → retrouver fichiers et
historique → obtenir le résultat. Même scénario pour Pi SDK et son principal challenger si le coût
de comparaison reste faible. Voir [recherche moteurs](companions-build-harnesses-2026-09-04.md).

Tests issus directement des incidents :

- Redémarrer le worker avant/après réception de la tâche par l'agent : pas de perte ni replay aveugle.
- Une Box qui démarre lentement ne bloque pas les autres Companions.
- Une routine arrive pendant l'arrêt de la Box, puis pendant un redémarrage du backend.
- Répéter un webhook ou une occurrence : un seul travail logique.
- Renouveler/révoquer une connexion, puis réveiller le Companion : comportement autorisé et visible.
- Annuler une tentative, puis refaire un lancement prouvé sûr : aucune annulation ancienne ne bloque
  éternellement le nouveau lancement.
- Couper le navigateur et le rouvrir : résultat et état terminal cohérents.

Mesurer séparément création, réveil, retard d'une routine, admission de tâche, première activité et
restitution à l'écran. Propositions de budgets à discuter, sans les annoncer comme performances
acquises : acceptation web < 1 s, admission sur machine chaude < 2 s, retard routine hors panne < 5 s.
Création/réveil demandent d'abord une mesure Box réelle ; le temps du modèle est suivi séparément.

## Questions encore ouvertes

La prochaine discussion porte sur les fonctionnalités et parcours concrets. Les questions de
plafonds, tarification et propriété ci-dessous restent en réserve, sans être des préalables.
Un [premier parcours produit](companions-build-product-walkthrough.md) déroule le cas coding évoqué
par Stan ; il s'agit d'une proposition de travail et non d'une cible client déjà confirmée.
Ce parcours décrit aussi la couverture fonctionnelle du MCP de contrôle demandé.

- Un maximum de réplicats par tâche, par Companion ou par compte, et portant sur la concurrence
  ou le nombre total de créations ?
- Quelles modifications de template le parent peut-il accepter et publier de façon autonome ?
- Les agents qui se délèguent des tâches appartiennent-ils toujours au même compte client ?
- Quelle allocation l'abonnement inclut-il et quelles unités d'usage sont visibles au client ?
- Après livraison, le client possède-t-il seul le Companion, ou le prestataire garde-t-il un accès
  de maintenance explicitement accordé ? Comment traiter les connexions utilisées pendant la préparation ?
- Ordinateur dormant autorisé ou disponibilité permanente recherchée ? L'ouverture explicite du
  bureau doit-elle le réveiller automatiquement ? Réveil automatique proposé pour ce parcours.
- Première intégration et première routine qui rendent le produit réellement utile à Stan ?
- Licence du nouveau projet et modèle d'accès aux fournisseurs ; aucun choix n'est verrouillé ici.

Prochaine étape : décider ces comportements, puis construire le prototype de fiabilité dans un
nouveau répertoire. Cette étude ne crée ni nouvelle application, ni tickets, ni engagement de migration.

## Vérification des notes

Liens locaux vérifiés. `pnpm verify:change --base HEAD` : 128 tests d'hygiène passent, un échoue
car `skills-lock.json`, présent avant cette étude, contredit `scripts/ios-devx.test.mjs:877`.
Aucun code applicatif n'a été modifié ; ce fichier préexistant est conservé.
