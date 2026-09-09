# Feature Spec: Chat stable et notifications de routines

## Summary

Cadrage produit validé avec Stan le 9 septembre 2026. Cette spécification prépare la
refonte ; elle ne décrit pas une livraison déjà réalisée.

Révision après revue : Stan a également validé un indicateur sur les avatars des autres
Companions pour leurs notifications et demandes d'intervention. Les contrats techniques
précisés ci-dessous sont des propositions d'implémentation ; le raccordement à l’admission native de messages est décrit dans Open Questions.

Le chat conserve les échanges avec le Companion et les messages adressés à son agent
principal. Les routines notifient l'humain dans un panneau distinct. Messages
intermédiaires, appels d'applications et thinking restent consultables dans un déroulé
stable, pendant l'exécution comme après rechargement.

Ce cadrage remplace, pour les routines, les règles de présence systématique dans le
chat et de publication humaine décrites dans `../companions-build.md`. Les autres
contrats produit restent applicables, notamment les sessions séparées et Pi natif.

## Problem

Les traces des routines encombrent la conversation sans toujours apporter une
information utile. Des messages intermédiaires semblent disparaître et des éléments
changent de place, ce qui brouille le rattachement des réponses aux demandes. Les
appels aux applications configurées ne sont pas identifiables dans le déroulé.

Constats de lecture du checkout, sans reproduction en production :

- `apps/web/src/components/RoutineChat.tsx` ajoute des traces d'exécutions silencieuses.
- `apps/web/src/App.tsx`, fonction `Chat`, calcule des positions du thinking et de
  certaines cartes à partir de timestamps dépendant de l'état courant.
- `packages/agent/src/pi-executor.ts` et `apps/server/src/executor.ts` capturent et
  persistent déjà des messages assistant séquencés. Un test dans `App.test.tsx`
  couvre leur conservation après complétion et rechargement. La disparition observée
  reste à reproduire ; le chemin de preview ancien et les versions déployées doivent
  être examinés avant de remplacer cette implémentation.
- `publish_to_chat` produit actuellement une publication pour l'humain. Ce chemin
  seul ne démontre rien sur les autres moyens de notifier l'agent principal.

## Goals

- Réserver le fil aux échanges qui appartiennent à la conversation de l'agent principal.
- Rendre les notifications humaines rapides à consulter et durables.
- Conserver les commentaires intermédiaires destinés à l'utilisateur.
- Montrer quelle application est utilisée, pour quelle action et avec quel état réel.
- Garantir une position stable des éléments et leur rattachement au travail concerné.

Le signal de réussite principal est observable : une même exécution conserve ses
messages et leur ordre pendant le streaming, après terminaison et après reconnexion ;
une routine silencieuse n'ajoute aucune entrée au chat.

## Non-Goals

- Redéfinir le steering, les files de messages ou l'interruption de Pi.
- Ajouter un second moteur de conversation ou une classification automatique des
  nouveaux messages humains en « précision » et « nouvelle demande ».
- Réécrire le scheduler, les politiques de publication ou la mémoire partagée.
- Étendre les notifications à l'email, au push système ou à tous les événements du produit.
- Modifier le routage des triggers et délégations : leur code peut être partagé avec les
  routines, mais cette refonte ne change pas implicitement leurs surfaces de publication.
- Inventer une nouvelle capacité de notification de l'agent principal : Stan indique
  qu'elle existe déjà ; retrouver son chemin fait partie de la préparation technique.

## Users And Use Cases

Le propriétaire d'un Companion échange avec lui pendant que des routines travaillent
dans des sessions indépendantes. Il peut observer les actions, quitter l'application,
retrouver les résultats et répondre à une routine bloquée sans mélanger les historiques.

## Proposed Behavior

### Destination des messages de routine

| Événement | Surface | Effet attendu |
| --- | --- | --- |
| Exécution silencieuse | Activité seulement | Aucune entrée dans le chat, aucune notification de réussite |
| Message destiné à l'humain | Notifications | Aperçu temporaire, entrée durable, accès au résultat et aux fichiers |
| Message adressé à l'agent principal | Chat, provenance routine visible | Réutilisation du mécanisme existant et des comportements natifs de Pi |
| Question humaine d'une routine | Notifications et indicateur Besoin de toi | Réponse directement transmise à la tâche concernée |
| Échec d'une routine | Notifications et activité | Signalement même si aucun résultat n'a pu être publié |

Un affichage dans le chat ne doit pas faire croire que l'agent a reçu un message si
celui-ci n'a été enregistré que pour l'interface humaine. Une notification pour
l'humain ne déclenche pas implicitement un travail dans la conversation principale.

### Notifications et interventions

Un bouton dans l'en-tête du Companion affiche le nombre de notifications non lues et
ouvre un panneau latéral. Une nouvelle notification propose un aperçu temporaire sans
déplacer le fil ni prendre le focus. Sa disparition ne supprime pas l'entrée durable.

**Visibilité entre Companions, validée :** chaque avatar de la navigation signale ses
notifications non lues et distingue un besoin d'intervention, sans se reposer uniquement
sur la couleur. Le libellé accessible donne les deux nombres. L'indicateur ouvre le
Companion concerné avec son panneau de notifications ; le clic ordinaire sur son avatar
conserve l'accès au chat. Sur mobile, le bouton ouvrant la navigation signale également
qu'une attention attend, puis les avatars présentent leur détail. Les indicateurs restent
disponibles depuis l'accueil. Aucun message n'est injecté dans le chat actuellement ouvert.
La navigation ne réveille aucune machine et respecte les protections de brouillon existantes.

Chaque entrée indique la routine, le type, la date et un résumé, avec accès aux détails
de l'exécution. Le panneau conserve les états de chargement et d'erreur réels. Sur écran
étroit, il utilise une surface adaptée à la largeur disponible avec fermeture explicite.

L'indicateur « Besoin de toi · N » reste visible près du chat tant que des questions de
routines sont en attente. Lire la notification ne résout pas la question. La réponse est
adressée à son identifiant de question et de tâche, puis l'état serveur confirme la suite.
Une erreur d'envoi conserve la réponse saisie et la question ouverte.

Le compteur d'intervention inclut uniquement une question non répondue dont la tâche reste
non terminale et accepte une réponse selon le contrat serveur. Une annulation, interruption
ou terminaison ferme l'intervention, conserve la question dans l'historique et expose sa
raison. En cas de course réponse/annulation, le serveur décide atomiquement ; le client
recharge la question exacte. Une réponse enregistrée affiche « Réponse transmise » tant
que la reprise n'est pas observée. Elle ne doit pas être présentée comme déjà exécutée.

Les brouillons sont rattachés à la question et conservés pendant la navigation dans la
session web, y compris après fermeture du panneau. Si une question devient terminale,
le brouillon reste récupérable mais l'envoi est désactivé. À la fermeture, le focus revient
au contrôle d'ouverture. Un panneau vide l'indique explicitement ; une erreur de chargement
propose une nouvelle lecture sans transformer un compteur inconnu en zéro.

Les échecs répétés d'une même routine sont regroupés dans les notifications, avec nombre
d'occurrences et accès à chaque exécution. Ils ne deviennent pas automatiquement des
questions « Besoin de toi ». Les demandes d'aide restent visibles en mode silencieux.

Matrice complémentaire proposée pour les états réels :

| État | Notifications | Intervention |
| --- | --- | --- |
| queued, preparing, running | Pas de notification d'avancement automatique | Seulement si une question reste actionnable |
| needs_input | Question durable, même en mode silencieux | Oui, jusqu'à réponse ou fermeture |
| succeeded | Selon la politique de publication humaine | Non pour les anciennes questions closes |
| failed | Échec groupable | Non, sauf demande distincte encore actionnable |
| interrupted | Interruption signalée, sans nouvelle tentative automatique | Non pour la tâche interrompue |
| cancelled | Historique d'activité, sans notification d'échec | Non |
| Occurrence manquée | Historique du scheduler, sans inventer une exécution | Non |

### Messages, outils et thinking

Les commentaires assistant destinés à l'utilisateur restent dans le fil après la réponse
finale. Les segments en cours se complètent sur place, sans être remplacés par une autre
réponse ni dupliqués lors de la réconciliation avec PostgreSQL.

Les appels aux applications présentent le logo, un libellé d'action compréhensible et un
état réel, par exemple « Linear · Recherche de tickets ». Les détails se déplient ; ils
distinguent notamment une consultation d'une modification. Un MCP personnalisé sans logo
dispose d'une icône neutre et de son nom. L'icône seule ne porte pas l'information.

Le détail minimal contient l'application, le nom d'outil, l'état, les horaires observés
et, seulement si un adaptateur l'autorise, une référence ou un résumé sûr du résultat.
Sans libellé fiable, afficher le nom d'outil, sans inventer sa fonction ni qualifier
l'action de lecture. Les arguments, erreurs et réponses MCP bruts restent exclus. Une
erreur applicative MCP (`isError`) est un échec même si le transport a réussi ; une perte
de résultat donne un état inconnu. Un changement de connexion ultérieur ne réattribue pas
les appels historiques à un autre compte.

Le thinking disponible est replié par défaut, distinct des commentaires, à une position
stable. Le passage de running à terminé ne le déplace pas. Ne pas fabriquer de thinking
si le modèle n'en expose pas. Les cartes restent attachées à leur événement et à leur
travail : une carte réellement produite avant la réponse finale peut rester avant elle.

Pour les nouveaux événements, conserver chaque segment de thinking avec l'identité de
son message Pi, sans écraser le précédent par le segment suivant. Chaque segment est
repliable à sa place. L'ancien champ unique reste affichable comme historique limité,
sans prétendre reconstruire les segments déjà perdus.

Le fil ne force pas le défilement lorsque l'utilisateur consulte des messages plus haut.
Un accès aux nouveaux éléments permet de revenir en bas. Le streaming et les notifications
préservent l'ancrage de lecture, ainsi que l'état ouvert/replié des détails existants.

## UX / API / System Details

- Respecter `../design-system.md` : interface sobre, identité du Companion, contrôles
  accessibles et adaptation mobile. Pas d'animation qui simule une progression.
- Réutiliser `ProviderMark` pour les marques connues. Conserver la provenance applicative
  au moment de l'appel plutôt que la déduire d'un texte ou d'un nom d'outil ambigu.
- Préserver les IDs de messages et le `responseRootId` partagé par les steers natifs.
  Plusieurs messages humains peuvent appartenir à une même réponse Pi.
- L'ordre doit provenir d'une identité et d'une position durables, avec départage
  déterministe. Ne pas recalculer des dates pour placer artificiellement une carte.
- La remontée des appels outils nécessite des événements persistés et une projection
  serveur ; elle ne peut pas se limiter à une animation frontend.
- La lecture du panneau n'exécute pas de travail et ne réveille pas de machine.
- L'agent doit retrouver ses capacités de publication existantes ; déplacer la surface
  humaine ne doit pas rendre ces outils inutilisables ou changer silencieusement leur sens.

**Contrat d'ordre proposé :** la position du fil est l'ordre de visibilité persisté par
le serveur, pas une tentative de synchronisation des horloges. À la première admission
d'un événement, allouer une position monotone par Companion, dans la même transaction que
sa projection. La date de production reste une métadonnée séparée. Dans un lot agent,
respecter l'ordre source Pi ; une lacune de séquence attend sa réconciliation au lieu de
réordonner ensuite les événements déjà visibles. Les fragments suivants mettent à jour
le même élément. Les cartes serveur reçoivent leur position au commit qui les rend visibles.

Exemple : le commentaire C est visible, puis les steers S1 et S2 sont acceptés ; une
carte K produite plus tôt arrive ensuite. Le fil reste C, S1, S2, K, puis la réponse R
si elle arrive après K. La date de K et son rattachement au run sont accessibles, mais
K ne remonte pas avant les steers. Si R est déjà visible lorsque K arrive, K reste après R.
Un reload restitue exactement les mêmes positions. « Accepté » ne signifie pas « pris en
compte par Pi » : seul un événement du moteur permettant cette conclusion l'autorise.

Cette précision remplace la formulation trop forte « ordre réel » du cadrage initial :
elle garantit un ordre de visibilité stable sans inventer une chronologie globale entre
deux machines. Aucun ordonnancement d'exécution Pi n'est modifié.

## Data And State

PostgreSQL reste la source de vérité du web. Le transcript Pi et le journal local restent
la propriété de l'agent. Les projections doivent supporter déduplication et reconnexion.

Les données nécessaires comprennent l'identité du Companion, la tâche et sa source,
l'identité de l'événement, sa position stable et sa date, sa destination et son état.
Une notification référence sa source, son état de lecture persistant et, si nécessaire,
la question ouverte. Lu et résolu sont deux états indépendants.

Une notification doit avoir une identité déterministe liée à sa source pour qu'une
observation répétée par l'executor ne crée pas de doublon. Un nouvel échec ajouté à un
groupe doit redevenir visible comme nouveau contenu. Préserver chaque occurrence.

Conventions proposées : lecture à l'ouverture du détail ; groupes d'échecs par routine
et journée dans son fuseau figé à l'occurrence. La lecture ne couvre que les occurrences
effectivement présentées, via un curseur/version serveur, jamais un futur membre du groupe.
Le compteur non lu compte les occurrences, y compris dans un groupe replié. Une nouvelle
occurrence après lecture incrémente donc le compteur. Besoin de toi compte séparément les
questions actionnables. Ces compteurs serveur ne dépendent pas de la page affichée.

Le panneau utilise une pagination par curseur stable, avec chargement des détails à la
demande. Les indicateurs inter-Companions exposent uniquement identités et compteurs autorisés,
pas le contenu de tous les historiques. Les invalidations déclenchent une relecture et
ne constituent pas à elles seules une preuve de nouvelle notification.

Pour les outils : identité de l'appel, run, application/connexion autorisée, libellé,
position et état terminal observé. Ne pas marquer un appel réussi faute de résultat.
Une issue inconnue reste inconnue ; son affichage n'autorise pas à rejouer l'action.

## Permissions And Trust Boundaries

Toutes les lectures, états de lecture et réponses restent limités au propriétaire.
Le rattachement Companion/tâche/question est vérifié côté serveur. Les détails outils
exposent une projection explicitement autorisée, jamais les credentials ou les payloads
fournisseurs bruts. Les comptes et ressources d'autres espaces ne doivent pas apparaître.

## Edge Cases

- Reconnexion pendant un appel : relecture sans doublon ni changement de position.
- Annulation ou crash : conserver le texte reçu et les états connus sans simuler une fin.
- Nouveau steer pendant une réponse : garder les messages et leur rattachement natif Pi.
- Routine renommée ou supprimée : conserver la provenance historique de l'exécution.
- Question déjà répondue dans un autre onglet : refléter l'état serveur ; ne pas soumettre
  une réponse à une autre tâche par défaut.
- Notification lue mais question ouverte : retirer le statut non lu selon la lecture,
  conserver l'indicateur d'intervention.
- Changement de Companion : aucune réponse réseau tardive ne remplit le mauvais panneau.
- Ancien runtime sans événements détaillés : afficher uniquement l'information disponible,
  sans prétendre reconstruire des commentaires ou appels perdus.

## Acceptance Criteria

- [ ] Une routine silencieuse réussie reste consultable dans l'activité et n'apparaît pas au chat.
- [ ] Un résultat pour l'humain crée une seule notification durable et aucune entrée conversationnelle.
- [ ] Un message réellement adressé à l'agent principal apparaît avec la provenance routine et
  est reçu par le mécanisme existant ; sa seule visualisation ne vaut pas réception.
- [ ] Une question de routine apparaît dans le panneau et dans le compteur Besoin de toi ;
  sa lecture ne la résout pas et sa réponse rejoint exactement la tâche concernée.
- [ ] Un échec produit une notification ; les occurrences regroupées restent toutes consultables.
- [ ] Non-lues et questions ouvertes sont restaurées après rechargement et isolées par propriétaire.
- [ ] Plusieurs commentaires assistant restent visibles après réponse finale, annulation et reload.
- [ ] Un appel MCP montre la bonne application, son action et son état observé, sans secret.
- [ ] Thinking, commentaires, appels et cartes conservent leur ordre pendant et après un run.
- [ ] Un steer humain pendant un run respecte Pi et ne duplique pas la réponse partagée.
- [ ] Le panneau est utilisable au clavier et sur mobile ; les aperçus ne volent pas le focus.
- [ ] Depuis un autre Companion et l'accueil, un indicateur permet d'ouvrir le panneau
  concerné ; le contrôle de navigation mobile signale également les attentions disponibles.
- [ ] Une carte reçue après deux steers reste à sa position d'admission après complétion et reload.
- [ ] L'annulation d'une routine ferme sa demande d'intervention ; une réponse concurrente
  ne relance pas une tâche terminale et conserve un résultat d'envoi vérifiable.
- [ ] Un nouvel échec dans un groupe lu incrémente les non-lues, indépendamment de la pagination.
- [ ] Plusieurs segments de thinking restent consultables et un MCP isError n'affiche pas de succès.
- [ ] Migration et rollback conservent l'accès à un résultat avec fichier et une question ouverte,
  sans doubler les notifications ou réexécuter les tâches.

## Test Plan

- Unit: règles de destination, ordre stable, déduplication, regroupement des échecs,
  indépendance lu/résolu et identification applicative sans données sensibles.
- Integration: persistance des événements et notifications, reprise executor, contrôles
  propriétaire, réponse à la bonne question, événements répétés et résultat d'appel inconnu.
- E2E / manual: chat actif avec commentaires, appel MCP, steer humain, routine silencieuse,
  notification et demande d'aide concurrentes ; observer streaming puis reload sur desktop
  et mobile, y compris navigation vers un autre Companion.
- Regression: repartir du test existant de conservation des commentaires ; couvrir ancien
  runtime, cancellation, crash recovery et historiques séparés. Reproduire le problème
  signalé avec les versions réellement utilisées avant d'annoncer sa correction.

Ajouter des scénarios adverses avec positions attendues : événements retardés, deux
steers, segments multiples, lecture et réponse multi-onglets, course réponse/annulation,
groupe lu recevant une nouvelle occurrence, compteurs avec plusieurs pages, arrivée sur
un autre Companion et absence de saut du scroll. Vérifier aussi la distinction entre
erreur MCP applicative, erreur de transport et résultat inconnu.

Suivre `../dev-workflow.md`, utiliser `./dev status --json` et les profils `./dev check`
ciblés, puis la vérification complète avant intégration. Les tests d'agents tournent dans
Docker Linux. Tout test Box éventuel archive ses seules machines et vérifie l'archivage ;
arrêter les stacks et tunnels possédés après validation, y compris après échec.

## Rollout

1. Résoudre le point technique sur la notification de l'agent principal et identifier les
   versions du web, du serveur et du runtime liées à la disparition signalée.
2. Ajouter les données et projections de manière compatible avec les lecteurs existants.
3. Livrer les événements détaillés dans une distribution agent construite avant déploiement.
4. Activer l'affichage une fois sa compatibilité prouvée, sans créer deux surfaces de
   notification humaine pour la même source. Traiter l'historique selon la règle ci-dessous.
5. Valider les critères de comportement sur un environnement isolé avant intégration.

Migration proposée : ajouter les notifications sans retirer les lignes `messages`
historiques. Les anciennes publications sont identifiées par la source routine de leur
run et leur identité de message, jamais par leur texte. Les projeter une seule fois,
avec leurs fichiers, comme déjà lues à un point de coupure enregistré ; les questions
actionnables restent signalées. Les écritures après ce point suivent les règles nouvelles.
La nouvelle UI filtre seulement ces publications humaines du fil, pas les événements
prouvés comme adressés à Pi. Le transcript Pi n'est jamais réécrit.

Avant basculement, conserver temporairement la projection historique des nouvelles
publications humaines en plus de leur notification, avec une clé de source commune.
La nouvelle UI montre le panneau ; l'ancienne montre sa projection historique. Une seule
surface est visible pour chaque version. Maintenir cette compatibilité jusqu'à la fin de
la fenêtre de rollback, sans remettre les politiques de notification de l'agent en cause.
Le point de coupure, le filtrage, la double projection et les vieux runtimes nécessitent
un test d'intégration transactionnel, incluant un changement de leader pendant migration.

## Rollback

Conserver les données et identités lors d'un retour à l'interface précédente. Ne pas
réexécuter les tâches pour reconstruire l'affichage. Maintenir un accès aux questions
ouvertes et notifications déjà créées ; valider ce chemin avant d'activer la nouvelle UI.

Le rollback supporté est un retour au lecteur précédent avec le serveur compatible et
les migrations additives conservés. Les résultats restent visibles via la projection
historique, les échecs via l'activité et les questions via leur chemin existant. Le statut
lu est conservé pour un retour ultérieur à la nouvelle UI. Un rollback complet vers un
serveur ne produisant plus les notifications exige une réconciliation des sources avant
réactivation ; il ne fait pas partie de ce chemin garanti sans validation distincte.

## Risks

Un mélange de versions peut expliquer une preview perdue malgré les tests récents.
Un tri par date réinterprétée peut sembler correct après reload tout en déplaçant des
éléments en direct. Une confusion entre message humain et message pour l'agent peut
déclencher du travail imprévu ou afficher une fausse réception. Les projections d'outils
risquent d'exposer des données sensibles si elles reprennent les résultats bruts.

## Open Questions

- **Raccordement réalisé dans cette branche** : le chemin natif existant est
  `acceptMessage` → lane main → `session.prompt(..., {streamingBehavior:"steer"})`.
  L'opération de contrôle `notify_agent` raccorde une routine active de ce Companion à
  cette admission, avec l'identité durable de la commande. Aucun mécanisme Pi n'est
  remplacé. La recherche n'avait pas établi un outil dédié déjà présent dans ce checkout ;
  l'adaptateur est ajouté explicitement, sans prétendre avoir retrouvé cet outil antérieur.
  `publish_to_chat` reste la publication humaine, affichée dans les notifications.
- **Propositions techniques à éprouver** : ordre de visibilité serveur, traitement des
  états complémentaires, règles de lecture/groupement et migration sont maintenant décrits
  explicitement dans cette révision. Ils ne constituent pas des preuves d'implémentation
  ni de nouvelles décisions de fonctionnement Pi.
- **Non bloquant, maquette** : durée de l'aperçu, largeur du panneau et présentation exacte
  des indicateurs. Leur sens, leur accès mobile et leurs libellés accessibles sont fixés.

## Handoff

Use this for review:
- Spec name: Chat stable et notifications de routines.
- Chosen scope: refonte du fil, notifications humaines de routines, interventions,
  visibilité MCP et stabilité des messages/thinking ; cadrage validé, code non modifié.
- Key decisions: destination agent/humain distincte, silence hors chat, panneau durable,
  Besoin de toi persistant, Pi natif, commentaires conservés et ordre stable.
- Highest-risk areas: raccordement de la notification agent existante, mélange des versions,
  déduplication, provenance des événements, séparation des historiques et des propriétaires.
- Acceptance criteria: liste observable ci-dessus.
- Open questions: preuves de validation de la branche ; propositions de contrats et de
  migration à éprouver, finitions visuelles à maqueter. Indicateurs inter-Companions validés.
