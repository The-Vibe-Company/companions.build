# Feature Spec: Spécialistes préparés, publiés et exécutés à la demande

## Summary

Décisions produit validées avec le propriétaire le 7 septembre 2026. Cette spécification
décrit la cible ; elle ne constitue pas un constat de fonctionnalités déjà livrées.
Arbitrages de revue intégrés le même jour, après délégation de décision par le propriétaire.
Périmètre : refonte complète de la préparation des spécialistes, de leur publication,
des connexions par équipe, des interventions, des améliorations et de leur admission.

Un spécialiste est une capacité réutilisable préparée dans une VM : instructions, skills,
logiciels, dépôts, fichiers et script d'initialisation facultatif. Un utilisateur le configure
en discutant avec lui, peut tester une copie, puis publie une version. Un coordinateur
mobilise une copie temporaire de cette version pour une intervention précise.

Le Companion conserve la relation avec l'utilisateur ; le spécialiste constitue une base
réutilisable ; l'intervention est une mission isolée qui se termine.

## Problem

La bibliothèque expose surtout un profil alors que le besoin est de préparer un environnement
capable de travailler immédiatement. La différence entre profil, agent permanent et copie
temporaire n'est pas suffisamment visible. Il manque un parcours de configuration avec chat,
MCP, installations et preuve du fonctionnement, ainsi qu'une boucle d'amélioration explicite.

Les primitives existantes ne suffisent pas : `saveTemplate` crée immédiatement une révision,
les permissions limitent les enfants par parent/template plutôt que par compte, et l'adoption
actuelle capture une intervention sans passer par le nouveau parcours de brouillon.
Le partage actuel part d'une base propre ; la copie d'état demandée ici change cette décision.

Références : [produit](../companions-build.md), [scope actuel](../v0.md),
[cycle de vie](../lifecycle.md), [templates](../../apps/server/src/templates.ts),
[bibliothèque](../../apps/web/src/components/SpecialistLibrary.tsx).

## Goals

- Passer d'une mission exprimée en langage naturel à un environnement spécialisé utilisable.
- Rendre visibles et modifiables la configuration et les opérations réellement accomplies.
- Séparer préparation, publication, composition d'équipe et exécution d'une mission.
- Réutiliser les installations sans réinstaller les dépendances au réveil d'un agent.
- Améliorer une base à partir des interventions, avec validation humaine et sans écrasement concurrent.
- Borner les VM actives, les créations horaires et les demandes en attente.

Signal principal de réussite : sur le cas développeur GitHub/Linear, l'utilisateur connecte
ses comptes dans le chat, fait préparer ses dépôts et outils, exécute une mission d'essai
sur une copie neuve et publie sans devoir reconstruire cette préparation ailleurs.
La plateforme distingue environnement préparé, test terminé et résultat jugé satisfaisant ;
un processus terminé ne prouve pas à lui seul la qualité du livrable.

## Non-Goals

- Hébergement d'applications ou aperçus web : piste future, pas de maintien de VM pour ce motif.
  Si ajoutés plus tard, les aperçus d'une délégation devront remonter au chat du coordinateur ;
  leur durée de disponibilité et leur éventuelle restriction aux Companions restent à arbitrer.
- Synchronisation automatique des copies partagées avec les publications du créateur.
- Scan exhaustif ou suppression automatique des secrets laissés dans les fichiers ou Chrome.
- Publication automatique d'une amélioration, test obligatoire ou fusion automatique de PR.
- Définition des prix et valeurs commerciales des plafonds.

## Users And Use Cases

- Créateur : configure, teste, publie, examine les améliorations et partage une copie indépendante.
- Coordinateur : demande une intervention, transmet un brief, reçoit états, résultats et propositions.
- Destinataire : reconnecte les MCP d'une copie reçue et la configure indépendamment.
- Titulaire du compte : abaisse sa limite personnelle ; administration : configure les plafonds d'offre.

Cas de référence : « Un spécialiste développeur avec GitHub et Linear ». Il demande les
connexions dans le chat, laisse sélectionner les dépôts et le périmètre Linear, clone les
dépôts choisis, inspecte leurs instructions et prépare les logiciels, dépendances et skills.
Le brief définit les actions autorisées et le livrable ; une PR et une mise à jour Linear
ne sont pas des effets implicites de toute création de spécialiste.

## Proposed Behavior

### 1. Préparer dans un brouillon

La création part du nom et du travail attendu. Le chat aide à préciser la spécialisation
et à réaliser la préparation, avec une fiche de configuration modifiable à côté : mission,
instructions, skills, MCP, logiciels, dépôts/fichiers de référence et initialisation.
L'utilisateur garde accès à la machine et à la configuration explicite.

Les cartes GitHub, Linear et autres MCP permettent de sélectionner un compte existant ou
d'en connecter un. Le spécialiste demande les informations réellement manquantes, prépare
les dépôts sélectionnés et les outils nécessaires dans la VM de brouillon. L'écran reflète
les opérations persistées, leur résultat et leurs erreurs, sans progression simulée.
Revenir au parcours reprend le brouillon et sa conversation existants.

### 2. Tester puis publier

« Tester une mission » crée une copie neuve du brouillon, distincte de sa conversation et
de sa machine de configuration, et exécute le même parcours d'initialisation qu'une intervention.
Le test est fortement proposé ; publier sans test reste possible et visible comme tel.
Un changement ultérieur du brouillon ne conserve pas artificiellement la validation du test
précédent : le résultat est rattaché à l'état effectivement testé.

Avant publication, « Vérifier le contenu partagé » présente les fichiers conservés et les
suppressions proposées par le spécialiste. L'utilisateur valide le nettoyage du brouillon.
Le rappel précise que l'état disque conservé, y compris sessions navigateur et identifiants
écrits dans des fichiers, accompagne la copie. Ce n'est pas une garantie de détection exhaustive.

La publication produit une version immuable de la VM préparée et de sa configuration,
sans les historiques de conversation ni les journaux d'exécution propres à sa source.
Changer seulement le chemin de transcript de la copie ne suffit pas : les anciens historiques
ne doivent pas rester lisibles ailleurs dans l'image livrée. Les connexions MCP gérées
par la plateforme restent séparées de cette image.

Une publication ne devient utilisable qu'après préparation vérifiée de ses artefacts.
Un échec conserve le brouillon et la version publiée précédente. Les nouveaux appels utilisent
la nouvelle version publiée ; ceux déjà acceptés conservent leur version, même en file d'attente.
La publication ne modifie pas les interventions existantes.

### 3. Composer une équipe et partager

La bibliothèque « Spécialistes » sert à préparer et publier. L'« Équipe » d'un Companion
sélectionne les spécialistes autorisés et les comptes utilisés. Les « Interventions »
restent rattachées aux tâches, sans devenir des Companions permanents dans la navigation.

Dans le même compte, les MCP du spécialiste utilisent ses connexions par défaut. Une équipe
peut remplacer chaque connexion par une connexion accessible au Companion. L'interface montre
le compte effectivement utilisé. Un remplacement ne change ni le profil global ni les autres équipes.
Une connexion obligatoire absente donne l'état « À connecter » et bloque le lancement ;
le coordinateur reçoit l'intégration manquante. Ce blocage est distinct d'un échec d'initialisation.

Partager crée une copie indépendante de la version choisie. Le destinataire reçoit l'image
préparée après vérification du contenu, mais aucune liaison aux connexions MCP du créateur.
Il reconnecte les intégrations nécessaires. Les sessions Chrome et identifiants laissés sur
disque sont conservés selon le choix produit explicite : le créateur est responsable de les
retirer s'il ne souhaite pas les transmettre. Les publications suivantes du créateur ne
mettent pas à jour cette copie.

### 4. Initialiser et travailler

Le script facultatif est écrit, expliqué et modifiable pendant la configuration ; il est
versionné avec le spécialiste. Il s'exécute une seule fois à la création d'une intervention,
avant sa mission et après résolution de ses connexions. Il peut actualiser les dépôts ou
effectuer les ajustements explicitement configurés. Aucun rafraîchissement automatique de
dépôt n'est imposé en dehors de ce script.

Une reprise ou un réveil ne le rejoue pas et n'installe pas de dépendances implicitement.
Son intention et son résultat sont journalisés durablement. Une exécution ambiguë n'est
jamais relancée automatiquement. Si le script échoue, le parent est informé et la mission
commence néanmoins ; le spécialiste peut diagnostiquer, réparer et proposer une amélioration.
Continuer ne signifie pas présenter l'environnement comme sain ni promettre une mission réussie.

Chaque intervention possède son identité, son transcript et son journal propres. Elle reçoit
la base publiée et le brief du coordinateur, pas l'historique complet du parent ou de configuration.

### 5. Proposer une amélioration

Une installation, correction de script ou amélioration de skill/instructions utile aux
missions futures peut déclencher une proposition spontanée. La carte arrive dans le chat
du coordinateur : changements, raison et lien vers l'intervention source.

« Examiner », puis « Appliquer au brouillon » préparent une nouvelle version du même
spécialiste. Une proposition ne publie rien automatiquement. La vérification des fichiers et
la proposition de test précèdent la publication comme pour la première version.

Une proposition garde sa version d'origine. Si le brouillon a évolué, les changements doivent
être réappliqués au brouillon courant ; remplacer aveuglément sa VM par un ancien snapshot
est interdit. Les modifications non transposables automatiquement demandent un arbitrage.
Une source expirée rend la proposition indisponible à appliquer, sans supprimer son explication.

### 6. Vie de la machine

Pi en cours de travail maintient la machine active, même sans message visible. Quand le travail
cesse, le délai est de 30 minutes sans nouvelle activité ou signal explicite du parent. Un
nouveau travail empêche l'expiration et un signal de maintien remet le délai à zéro.
Attendre une réponse humaine n'émet pas indéfiniment des signaux automatiques.

À expiration, archiver la machine en conservant son disque, plutôt que le détruire. Les résultats
doivent être durablement conservés avant l'archivage ; vérifier l'état réellement observé chez Box.
Une proposition en attente ne justifie pas une machine active. La durée disponible pour récupérer
son disque dépend de la rétention fournisseur, à vérifier avant affichage d'une date garantie.

### 7. Admission par compte

Deux limites distinctes encadrent la simultanéité et les démarrages de VM par heure (création,
fork et reprise compris). Le plafond
de l'offre est administrable ; le titulaire peut imposer une limite personnelle inférieure.
Un garde-fou global protège aussi le quota Box cumulé entre comptes.

Les VM en préparation, au travail ou dans leurs 30 minutes de maintien occupent une place.
Les VM de configuration et d'essai sont également soumises à admission ; les interventions
en attente et machines archivées ne consomment aucune place active. Les limites par équipe
existantes ne doivent pas permettre de contourner le plafond du compte.

Les demandes acceptées sont persistées dans une file bornée par compte, dans l'ordre d'arrivée,
et annulables. L'ordre d'arrivée s'applique aux demandes éligibles : une connexion manquante
ou une permission retirée bloque sa demande, sans bloquer les suivantes. Elles démarrent
automatiquement lorsque les contraintes de connexion, de place
et de création sont satisfaites. La file pleine produit un refus explicite, pas une acceptation
silencieuse. Le coordinateur voit « En attente d'une place » ou la cause effective de l'attente.

Une intervention inactive sans maintien explicite peut être archivée avant ses 30 minutes
pour libérer une place. Libérer la place exige confirmation de l'archivage. Baisser un plafond
sous l'occupation actuelle bloque les admissions supplémentaires sans interrompre les missions.

### 8. Arbitrages d'exécution issus de la revue

**Passage de relais sous quota.** Configuration, test, capture, application d'amélioration et
réveil d'archive passent tous par l'admission. Chaque VM active ou réservée compte ; un simple
appel de capture sans nouvelle VM ne réserve pas une seconde place. Avec une seule place,
« Tester » fige la génération, archive le brouillon après arrêt de ses travaux, attend la
confirmation fournisseur, puis lance la copie d'essai. L'écran annonce « Configuration en pause
pendant le test ». Après le test, sa VM peut être archivée immédiatement pour permettre le
retour au brouillon. Aucun dépassement temporaire du plafond n'est autorisé. Les opérations
techniques dépendantes sont des étapes d'une même demande, pas des demandes qui attendent
une capacité occupée par leur propre prédécesseur.

Un brouillon inactif est lui aussi archivé après 30 minutes, avec son chat conservé ; un onglet
ouvert ne suffit pas à le maintenir. Un travail de configuration actif, une capture ou une
prise en main humaine active empêchent l'arrêt pendant leur exécution. Revenir demande une
reprise de la même VM sous quota, sans init automatique. Après publication, proposer « Ajouter
à une équipe » sans démarrer d'intervention. Le créateur juge le résultat du test par
« Satisfaisant » ou « À corriger » ; un succès technique reste une information distincte.

**Installations.** Les dépendances de projet et outils en espace utilisateur passent par le
shell isolé de Pi. Les paquets système passent par une demande structurée persistée, traitée
par l'exécuteur via un helper privilégié à opérations bornées. Pi ne reçoit ni sudo ni shell
root arbitraire. La première version prend en charge les paquets apt des dépôts configurés et
les outils installables en espace utilisateur ; un autre installateur privilégié est déclaré
non pris en charge, avec une alternative proposée. Le résultat vérifié et la recette sont
conservés pour les propositions d'amélioration. Ce chemin étend explicitement le contrat actuel
du builder sans réinstaller les dépendances au réveil. Un script init n'obtient pas davantage
de privilèges que Pi ; il utilise la même demande structurée pour les installations système.

**Capture cohérente.** Test et publication figent la génération en base et suspendent les
mutations de configuration, scripts et opérations desktop avant capture. Le gel couvre les
processus gérés par le produit ; les autres services susceptibles d'écrire doivent être arrêtés
ou leur écriture stabilisée avant validation. À défaut, la capture reste bloquée, pas déclarée
cohérente. Le nettoyage du contenu est réversible jusqu'à validation et ne retire pas le chat
du brouillon. Une copie de préparation d'image, sous quota, retire uniquement les chemins gérés
par le produit : historiques/journaux source, secrets runtime, liaisons MCP, identité d'agent et
services susceptibles de relancer cette identité. Elle conserve les sessions Chrome et fichiers
utilisateur validés. Chaque intervention reçoit ensuite une nouvelle identité technique.
Les règles `.boxignore` sont inspectées : une exclusion de dépendances requises doit être
résolue avant de présenter l'environnement comme préparé. Le test référence le même artefact
immuable que la publication ; un nettoyage ou changement postérieur invalide cette référence.

**Améliorations applicables.** Une proposition contient sa base, les modifications de
configuration, les fichiers sélectionnés avec leurs empreintes avant/après et les recettes
d'installation. Le disque source complète cette description. L'application vérifie la base
de chaque changement et travaille sur une copie du brouillon, sous quota ; seul un résultat
confirmé remplace la génération courante. En cas de divergence, le chat de configuration aide
à réappliquer les changements sur l'état courant. Une modification opaque de VM ne devient
pas une fusion automatique : la carte indique « Reconstruction nécessaire ». Une simple
explication n'autorise pas le bouton « Appliquer ». Les données nécessaires sont conservées
durablement avant archivage ; une source réellement supprimée/indisponible est signalée.

**Initialisation bornée.** Durée par défaut : 10 minutes, réglable par l'administration. Le
journal suit l'exécution et son groupe de processus indépendamment de la requête HTTP. À la
borne, demander l'arrêt et attendre sa confirmation avant de commencer la mission avec un
avertissement. Un échec terminal connu permet aussi de poursuivre. Si le processus est encore
actif ou son arrêt indéterminé, la mission reste en réconciliation et le parent en est informé.
Ne jamais convertir une perte de réponse en échec terminal ni rejouer automatiquement le script.
Une réparation est une nouvelle action explicite dans la mission, distincte du rejeu de l'init.

**Connexions et autorisation.** L'admission revalide la permission d'équipe et les comptes au
démarrage, y compris après attente. Les outils git et scripts utilisent un courtier d'accès
lié aux mêmes connexions autorisées, sans enregistrer les credentials plateforme dans les
URLs git, fichiers de configuration ou images. La révocation empêche les nouveaux usages du
courtier. Cette frontière ne prétend pas révoquer des sessions navigateur conservées volontairement.

**Activité et TTL.** Le maintien explicite est un bail de 30 minutes, pas un drapeau permanent.
Une absence de texte n'est pas un signal d'arrêt de Pi. Le runtime transmet son état actif à
l'exécuteur ; une perte de contact donne un état inconnu à réconcilier. Le TTL fournisseur est
un garde-fou renouvelé, distinct du délai d'inactivité : cible de deux heures, renouvellement
toutes les 15 minutes tant que l'état actif ou un bail est confirmé. L'exécuteur vérifie le
nouvel `archiveAfter` observé. Un échec de renouvellement est visible ; une panne prolongée du
contrôle peut conduire à un arrêt fournisseur, jamais à un rejeu automatique de la mission.

**Valeurs initiales administrables.** Faute d'offre commerciale figée, partir de 2 VM actives,
10 démarrages par heure et 20 demandes en attente par compte produit. Ces valeurs sont des
défauts d'exploitation, pas une promesse tarifaire ; le titulaire peut les abaisser. Le quota
global lit les limites effectives du portefeuille Box et réserve les fenêtres glissantes minute,
heure et jour. Tout démarrage, y compris une reprise technique, est comptabilisé. Une erreur
429 remet la demande en attente avec sa cause ; une réponse perdue conserve la réservation
jusqu'à réconciliation de l'identité originale. Ne pas déduire les quotas d'un prix d'offre.

### 9. Conservation et preuves fournisseur

Documentation officielle consultée le 7 septembre 2026 :

- [Snapshots & Copies](https://docs.ascii.dev/box/snapshots.md) : les archives persistent par
  défaut pendant la vie de la Box ; les templates nommés sont indépendants de la machine
  source. L'arrêt conserve le disque sans facturation de machine active. Il ne conserve pas
  les processus en cours, et certaines données, dont le cache de build Docker, sont exclues.
- [Data retention](https://docs.ascii.dev/box/data-retention.md) : le mode zero data retention
  supprime les archives et snapshots nommés. Il est incompatible avec ce parcours ; sa
  désactivation sur le compte fournisseur est un prérequis d'activation, jamais une mutation
  silencieuse de réglage par le produit.
- [Billing & Limits](https://docs.ascii.dev/box/billing.md) : création, fork et reprise comptent
  comme démarrages ; `GET /limits` expose les fenêtres glissantes minute/heure/jour et le scope
  portefeuille. Les plafonds effectifs du compte déployé doivent être lus avant activation.
- [Long-Running Tasks](https://docs.ascii.dev/box/long-running-tasks.md) : le TTL fournisseur
  court depuis le démarrage, indépendamment de l'activité ; il peut être prolongé par API.

La règle supposée « sept jours » n'est donc pas retenue. Aucune suppression automatique des
archives à sept jours n'est ajoutée. Les versions publiées utilisent un snapshot nommé unique
par version, confirmé prêt avant activation, conservé tant qu'une version, livraison ou demande
acceptée le référence. Une copie livrée possède ses propres références durables ; retirer la
source ne les libère pas. Une limite de snapshots bloque la nouvelle publication avec un état
actionnable, sans supprimer l'ancienne. Aucun nettoyage ne supprime une référence encore utilisée.
Ces garanties ne sont pas une promesse de stockage éternel : une indisponibilité fournisseur
ou une suppression explicite reste un état d'erreur visible.

## UX / API / System Details

Les mutations doivent couvrir brouillon/configuration, connexion, test, publication, demande
d'intervention, annulation, maintien en vie, proposition/amendement et limites de compte.
Les noms de routes seront fixés pendant la conception technique, en réutilisant les contrats
existants lorsqu'ils peuvent préserver ces comportements.

Toute opération externe découle d'une intention persistée ; seul l'exécuteur crée, initialise,
capture ou archive une machine. Les identifiants de commande restent stables après reconnexion,
double clic ou redémarrage. L'admission réserve atomiquement les capacités avant création et
réconcilie les effets ambigus ; plusieurs coordinateurs ne peuvent dépasser ensemble un plafond.
Les retries d'une même création utilisent la même identité, sans consommer des VM supplémentaires.

Le parcours permet de reprendre une connexion ou une préparation en erreur. Il reste utilisable
sur mobile : chat et fiche accessibles sans débordement horizontal ni disparition des actions.
Les cartes de résultat et d'amélioration sont persistées, pas uniquement des événements de streaming.

## Data And State

Étendre les modèles existants plutôt que dupliquer leur source de vérité :

| Objet | Données et états nécessaires |
| --- | --- |
| Spécialiste | Propriétaire, identité, révision publiée, brouillon courant |
| Brouillon | VM source, génération, configuration, script, état de préparation/publication |
| Révision | Artefact immuable, instructions/skills/script, exigences MCP, preuve de préparation |
| Connexions | Défauts du spécialiste et remplacements par équipe ; références de comptes, pas secrets dans les cartes |
| Test | Génération testée, intervention, résultat et appréciation distincts de la simple terminaison |
| Intervention | Commande, parent/tâche, révision figée, connexions résolues, attente/préparation/exécution/résultat |
| Initialisation | Identité stable, non commencée/en cours/réussie/échouée/ambiguë |
| Machine | Intention et état observé séparés, activité Pi, dernier maintien, archivage et rétention connue |
| Proposition | Source, révision de base, changements, en attente/appliquée/refusée/conflit/source indisponible |
| Admission | Limites, file, réservations atomiques, créations horaires et garde-fou fournisseur |

PostgreSQL fournit les états web ; l'agent possède son transcript Pi et son journal local.
Un compte déconnecté reste révocable : une intervention ne doit pas contourner la révocation
en réutilisant des références MCP précédemment résolues.

## Permissions And Trust Boundaries

Le propriétaire configure et publie ; le coordinateur autorisé demande des interventions et
peut transmettre une proposition, mais ne publie pas seul. Les identifiants de compte fournis
par le client ne font jamais autorité sur le propriétaire ou les comptes accessibles.

Les connexions MCP ne sont ni copiées dans les images ni exposées dans les journaux, erreurs,
cartes ou documents. La conservation volontaire des sessions navigateur/fichiers est une
frontière distincte, explicitement expliquée au moment du partage. Aucun écran ne doit promettre
« aucun compte partagé » lorsque l'image peut conserver des sessions connectées.

Les outils shell des agents locaux restent dans Docker Linux. Ne jamais utiliser le shell
du poste développeur pour simuler une installation demandée au spécialiste.

## Edge Cases

- Publication concurrente : une génération attendue devenue obsolète produit un conflit visible.
- Déconnexion d'un MCP pendant l'attente : revalider les accès avant lancement, sans créer une VM inutile.
- Annulation concurrente avec admission : une seule décision persistée ; réconcilier toute VM déjà créée.
- Crash après initialisation envoyée : conserver l'ambiguïté, prévenir, ne pas rejouer le script.
- Échec d'archivage : afficher l'erreur, conserver l'occupation et réconcilier le même identifiant Box.
- Travail Pi actif mais muet : ne pas inférer l'inactivité depuis l'absence de texte dans le chat.
- Proposition après rétention expirée : explication conservée, aucune restauration fictive.
- Plusieurs copies d'un spécialiste : aucune conversation, connexion d'une autre équipe ou résultat privé ne fuit.
- Réponse de création fournisseur perdue : réconcilier la demande originale avant toute nouvelle création.

## Acceptance Criteria

- [ ] Créer un spécialiste développeur permet de connecter/sélectionner GitHub et Linear dans le chat et de préparer les dépôts choisis.
- [ ] La fiche et le chat affichent les installations observées et leurs échecs, et reprennent après rechargement.
- [ ] Modifier le brouillon ne modifie pas la version publiée ; un test utilise une copie isolée de la génération testée.
- [ ] Publier sans test est possible et ne présente pas de test réussi ; la vérification du contenu partagé précède la publication.
- [ ] Une copie contient les logiciels/fichiers retenus et sessions disque prévues, mais aucun historique Pi de sa source ni connexion MCP plateforme.
- [ ] Les nouveaux appels utilisent la version publiée, les demandes déjà acceptées conservent la leur.
- [ ] Deux équipes peuvent utiliser des comptes MCP différents pour le même spécialiste sans interférence.
- [ ] Une copie partagée est indépendante et indique « À connecter » jusqu'à satisfaction des intégrations obligatoires.
- [ ] L'initialisation se produit une fois par nouvelle intervention ; erreur signalée et mission poursuivie, sans retry automatique après interruption.
- [ ] Une amélioration persistée apparaît dans le chat parent et rejoint le brouillon uniquement après acceptation, sans publication implicite.
- [ ] Deux améliorations concurrentes ne peuvent écraser silencieusement leurs changements respectifs.
- [ ] Une mission Pi active dépasse 30 minutes sans archivage ; l'inactivité sans maintien déclenche l'archivage après 30 minutes.
- [ ] Le disque et les résultats restent récupérables pendant leur rétention effective ; une source expirée est signalée.
- [ ] Des demandes simultanées de plusieurs parents respectent le plafond du compte et le garde-fou de création fournisseur.
- [ ] Configuration et essais sont comptabilisés ; attente et archives ne le sont pas ; la file bornée est persistée et annulable.
- [ ] Une machine inactive peut libérer une place avant expiration, après confirmation fournisseur et en l'absence de maintien explicite.
- [ ] Avec un plafond de 1, configuration → test → retour se termine sans dépassement ni attente circulaire ; la conversation du brouillon est conservée.
- [ ] Une capture concurrente avec une modification ne publie pas un état non vérifié ; le test référence l'artefact effectivement publié.
- [ ] Une demande de paquet système suit le helper borné ; une opération non prise en charge ne produit pas de succès fictif.
- [ ] Un timeout d'init ne lance pas la mission tant que l'arrêt du processus reste indéterminé.
- [ ] Une reprise passe par les quotas actifs et de démarrages ; une demande sans accès MCP ne bloque pas les autres demandes éligibles.
- [ ] Une image dérivée ne peut pas redémarrer sous l'identité runtime de sa source ; les sessions utilisateur volontairement conservées restent distinctes.
- [ ] Une limite de snapshots ne détruit aucune version existante ; une livraison reste indépendante du retrait de sa source.

## Test Plan

- Unit: résolution des connexions, calcul des limites, délais/activité/maintien, génération testée et conflits de proposition.
- Integration: PostgreSQL et fournisseur contrôlé ; admission concurrente entre parents, FIFO, limites horaires, annulation,
  publication atomique, révocation MCP, init échouée/ambiguë, crash entre effet externe et checkpoint, archivage échoué.
- E2E / manual: onboarding GitHub/Linear sur dépôts de test, préparation, test isolé, publication, deux équipes avec
  connexions différentes, partage indépendant, correction d'initialisation et acceptation de carte d'amélioration.
  Vérifier desktop/mobile et absence d'anciens transcripts dans une image copiée.
- Regression: requêtes dupliquées, histoires isolées, sorties durables, délégation existante, reprise du même agent,
  confidentialité des journaux et non-installation de dépendances au réveil.

Après tout test live, archiver uniquement les Box possédées par le test, vérifier leur état fournisseur
en préservant les disques, et arrêter les stacks/tunnels du test, y compris après échec.

## Rollout

Ajouter les données et contrats de façon compatible, derrière activation contrôlée. Les profils actuels
restent des versions publiées utilisables ; leur modification ouvre un brouillon. Ne pas lancer de
machines pendant une migration. Construire la distribution avant tout déploiement.

Livrer progressivement : admission et cycle de vie de toutes les VM ; préparation et captures
cohérentes ; brouillon/onboarding/test/publication ; connexions et partage ; initialisation et
améliorations. Les limites encadrent les créations et reprises dès la première ouverture.

Mettre à jour les documents produit, scope et partage dans les changements d'implémentation correspondants.
Le changement de partage d'état disque nécessite un parcours explicite ; ne pas convertir silencieusement
une ancienne livraison « base propre » en livraison avec sessions conservées.

## Rollback

Désactiver les nouveaux parcours/admissions sans supprimer brouillons, versions, résultats ou journaux.
Laisser l'exécuteur réconcilier et archiver les machines déjà possédées. Ne pas rejouer les commandes
en attente avec d'autres identifiants. Les anciennes versions publiées restent disponibles ;
un retour de version est une nouvelle publication explicite. Ne pas revenir à un ancien exécuteur
incapable de lire les nouveaux états tant que ces opérations ne sont pas drainées ou prises en charge.

## Risks

Le partage de disque peut transmettre sessions et documents : responsabilité utilisateur assumée,
mais information exacte obligatoire. La séparation technique des secrets MCP et historiques reste requise.
Les modifications arbitraires d'une VM ne se fusionnent pas comme du texte ; leur application peut
nécessiter une réparation assistée. La rétention fournisseur peut faire expirer une amélioration.
Un maintien en vie explicite prolonge les coûts tout en occupant les places disponibles.

## Open Questions

- **Vérifications avant activation, sans nouvel arbitrage produit** : lire limites et politique
  de rétention du portefeuille Box réel, valider renouvellement TTL et snapshot nommé, puis
  prouver les captures isolées et le passage de relais à quota=1 par tests contrôlés.
- **Non bloquant** : ajuster les valeurs d'exploitation après mesure et finaliser la forme
  visuelle des cartes. Les contrats de comportement et valeurs par défaut sont fixés ci-dessus.
- **Hors périmètre** : aperçu web, accès public/privé et éventuel hébergement par les Companions.

## Handoff

Use this for review:
- Spec name: Spécialistes préparés, publiés et exécutés à la demande.
- Chosen scope: refonte validée, de l'onboarding conversationnel aux limites de compte ; aperçus exclus.
- Key decisions: brouillon/publication, copie VM sans historique, MCP séparés, partage indépendant,
  init unique et non bloquante sur erreur, propositions humaines, archivage après inactivité, admission bornée.
- Highest-risk areas: état disque partagé, rétention fournisseur, effets ambigus, amélioration concurrente,
  réservation atomique des capacités et changement du contrat de livraison existant.
- Acceptance criteria: cases observables ci-dessus ; priorité aux crashs, duplications, isolation et admission.
- Open questions: validation sur le compte fournisseur réel et tests d'implémentation avant activation ; aucune échéance arbitraire à sept jours.
