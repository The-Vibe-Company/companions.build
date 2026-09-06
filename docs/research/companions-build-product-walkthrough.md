# companions.build — premier parcours produit

> Parcours exploratoire conservé comme historique. Depuis le 5 septembre 2026, le
> [cadrage produit consolidé](../companions-build.md) est la référence à lire et à mettre à jour.

État : proposition fonctionnelle à discuter. Le cas coding reprend l'exemple de Stan ; il n'est
pas encore confirmé comme premier marché. Les choix acceptés sont conservés dans le
[cadrage](companions-build-foundations-2026-09-04.md). Cette note décrit le futur produit, pas une
application déjà construite. Facturation détaillée et plafonds sont hors de cette discussion.

## La promesse

Créer un collaborateur qui possède son ordinateur, utilise les outils connectés, travaille après
fermeture du navigateur et peut se faire aider. Tout se pilote depuis son chat, avec une fiche
simple pour voir et modifier ce qui est configuré.

## Exemple : livrer un responsable technique à un client

### 1. Créer le Companion

Depuis « Nouveau Companion », choisir une création vierge ou un template. Donner un nom et une
mission : « Tu entretiens notre application et prépares les corrections des bugs. » Le chat s'ouvre
immédiatement et affiche l'avancement du démarrage. L'acceptation d'un message est distincte de la
disponibilité de la machine ; l'interface ne simule pas un agent déjà prêt.

La fiche du Companion permet aussi de modifier directement instructions, skills, connexions et
automatismes. Une configuration effectuée dans le chat apparaît dans cette même fiche : une seule
configuration, deux façons de la modifier.

### 2. Le rendre opérationnel

Connecter GitHub et le gestionnaire d'issues, puis sélectionner le dépôt concerné. Réutiliser les
connexions existantes ; demander un consentement ou un choix uniquement lorsqu'il manque réellement.
Ajouter des skills depuis des fichiers ou un package, sans bibliothèque Skills Hub obligatoire.

Le Companion vérifie les accès utiles à sa mission et indique ce qu'il peut faire. Les installations
nécessaires au projet de travail sont distinctes du runtime préinstallé. Une configuration prête
peut devenir un template pour éviter de répéter ces installations chez les prochains exemplaires.

### 3. Lui confier du travail

Exemple de message : « Analyse ces trois bugs et prépare les corrections. » Le Companion conserve
le contexte dans son unique chat et affiche une tâche avec son état, les décisions attendues et le
résultat. Le navigateur peut être fermé puis rouvert sans perdre ce travail.

Le résultat est concret : une explication, une proposition de code, un fichier ou un lien vers une
pull request selon les capacités accordées. Fusionner du code n'est pas implicitement inclus dans
la demande de préparer une correction.

### 4. Lui donner des spécialistes

Créer un template Développeur avec instructions, skills et environnement de travail prêt. Attacher
ce template au Companion comme spécialiste qu'il peut lancer. Lui donner également accès à un
Companion Relecteur existant.

Le parent peut alors lancer un enfant par correction indépendante, puis transmettre le travail
terminé au Relecteur. Une carte dans le chat montre les tâches déléguées et leur progression. Un clic
ouvre le détail d'un enfant ; il n'apparaît pas comme un nouveau Companion permanent dans la liste.
Le parent rassemble les résultats et répond au client. Le chat principal reste disponible pendant
ces travaux ; l'ordonnancement précis des délégations est à concevoir pour respecter cette promesse.

### 5. Améliorer le prochain lancement

Un enfant a installé un outil utile et a terminé sa tâche. Avant suppression de sa Box, le parent
peut choisir de la conserver comme nouvelle version du template Développeur. L'activité montre
la préparation du template puis sa disponibilité ; la capture ne bloque pas les autres travaux.

Les prochains enfants partent de cette version prête. Les enfants déjà actifs continuent sur leur
version. La Box temporaire peut être supprimée lorsque sa capture est confirmée. Le résultat de
la tâche et l'historique de la promotion restent consultables.

### 6. Programmer le travail

Dans le chat : « Chaque matin, fais le point sur les bugs ouverts. » Le Companion crée une routine
visible et modifiable dans sa fiche. Elle affiche la prochaine exécution et le dernier résultat.
Une routine s'exécute dans sa propre session, sans monopoliser le chat ; les routines attendent
entre elles lorsqu'une routine est déjà active.

Les triggers constituent un parcours à part entière, détaillé ci-dessous ; ils ne passent pas par
une routine ni par une validation LLM systématique.

### 7. Livrer au client

Le prestataire a préparé un Companion avec sa mission, ses skills et ses spécialistes. Une action
de livraison invite le client à activer son abonnement companions.build et ses connexions.
Le client retrouve une configuration déjà utile. Le moment exact du transfert de propriété et
l'accès de maintenance restent à décider ; les credentials de préparation ne sont pas hérités
implicitement.

## Triggers : un webhook peut lancer le Companion

Besoin confirmé par Stan le 5 septembre : réagir notamment à une CI qui échoue sur main ou à une
nouvelle issue Sentry. Chaque trigger désigne une source, un Companion cible et une consigne.
L'utilisateur choisit entre deux modes :

- **Direct** : chaque livraison valide correspondant à la source configurée crée une tâche.
- **Filtré par code** : une fonction examine le payload ; seul un résultat strictement vrai crée
  une tâche. Aucun LLM n'intervient pour évaluer ce filtre.

Exemple proposé pour une source GitHub limitée aux événements `workflow_run` d'un dépôt choisi :

```js
function shouldTrigger(payload) {
  return payload.action === "completed"
    && payload.workflow_run?.head_branch === "main"
    && payload.workflow_run?.conclusion === "failure";
}
```

Consigne associée : « Analyse cet échec de CI et prépare une correction. » Une CI réussie ou une
exécution sur une autre branche est ignorée avant réveil du Companion. GitHub documente l'événement
`workflow_run`, livré aussi bien pour un succès que pour un échec ; l'adaptateur doit donc examiner
la conclusion. [Source GitHub](https://docs.github.com/en/webhooks/webhook-events-and-payloads#workflow_run).

Pour Sentry, sélectionner l'événement `issue.created` et le projet souhaité, puis déclencher
directement ou filtrer les champs effectivement livrés (catégorie, priorité, niveau, etc.). Une
nouvelle occurrence d'une erreur existante est différente d'une nouvelle issue. Les service hooks
`event.created` ne sont pas un remplacement équivalent. Ne pas supposer qu'un webhook d'issue
contient tous les tags d'environnement d'un événement.
[Source Sentry](https://docs.sentry.io/integrations/integration-platform/webhooks/issues/).

Parcours de configuration : choisir la connexion et la source, définir la consigne, activer le
mode direct ou code. Le Companion peut écrire le filtre depuis une demande en langage naturel,
mais son exécution à chaque livraison est déterministe. Un bouton « Tester » évalue le filtre
sur un exemple ou une livraison enregistrée, sans déclencher de tâche. Afficher accepté, ignoré
ou erreur, ainsi que le code évalué. Les tests peuvent être répétés après modification du filtre.
Les connecteurs pris en charge enregistrent le webhook automatiquement avec les accès disponibles.
Un webhook générique peut compléter ces connecteurs sans imposer une configuration manuelle aux
utilisateurs des intégrations gérées.

Flux proposé : vérifier l'origine/authenticité → enregistrer et dédupliquer la livraison → évaluer
le filtre si présent → ignorer, signaler une erreur ou créer durablement une tâche → réveiller le
Companion si nécessaire. Le mode direct conserve authentification et déduplication. Une erreur,
un dépassement de temps ou un retour non booléen du filtre ne lance pas le Companion ; l'échec est
visible et distinct d'un filtre qui retourne faux. La décision et la version du filtre doivent
être conservées pour éviter qu'un retry recrée une tâche ou réinterprète silencieusement le même
événement avec un nouveau filtre.

Le code utilisateur s'exécute dans une isolation dédiée hors du processus API et hors de la Box
du Companion. Un filtre pur sur le payload, sans réseau ni installation de dépendances, est la
proposition initiale pour rester rapide ; langage et moteur d'isolation ne sont pas encore choisis.
Une réception HTTP ne garde pas ouverte la requête fournisseur pendant cette exécution. Le test
essentiel : un flux de webhooks ignorés ne provoque aucun appel modèle ni réveil de Companion.

## Bureau interactif : prendre la main sur l'ordinateur

Besoin confirmé : l'utilisateur peut manipuler le bureau pour installer un logiciel, connecter un
compte dans le navigateur ou débloquer une étape interactive. Une action « Ouvrir le bureau » depuis
le chat ouvre la machine concernée. Réveiller automatiquement une Box endormie est proposé pour
cette action explicite ; lire le chat ou afficher la liste ne la réveille pas.

Box fournit un bureau Linux interactif accessible par navigateur. Son mode VNC exige une page de
premier niveau pour l'authentification ; le parcours initial peut donc ouvrir un onglet dédié,
avec le chat restant disponible. Ne pas promettre l'intégration VNC en iframe. Le premier accès
VNC nécessite une préparation de quelques secondes : démarrer le streaming à la demande pour ne
pas l'ajouter au chemin critique du démarrage de l'agent.
[Source Box](https://docs.ascii.dev/box/desktop-streaming).

Proposition d'interaction : « Prendre la main » réserve les interactions souris/clavier à l'humain,
et « Rendre la main » permet à l'agent de reprendre. Les routines ou outils utilisant le même bureau
doivent respecter cette réservation ; les tâches indépendantes du bureau peuvent continuer. Fermer
l'onglet ne termine pas les tâches du Companion. La reprise après déconnexion doit être explicite
et ne pas laisser une réservation périmée bloquer le bureau indéfiniment.

Le Companion peut reprendre un navigateur connecté s'il utilise le même profil de navigateur et
dispose de l'outil de contrôle correspondant. Une connexion dans le navigateur ne crée pas un grant
MCP/API ; ces deux accès doivent être présentés avec leur capacité réelle. Les profils navigateur
et cookies demandent aussi un traitement explicite lors de la promotion d'une Box en template :
ils ne sont pas automatiquement partagés avec les enfants ou avec d'autres clients. L'accès au
bureau est accordé depuis companions.build, sans compte Box à gérer pour le client.

## MCP de contrôle : toute la configuration accessible à l'agent

Exigence confirmée par Stan : toute configuration du produit doit être réalisable par l'agent via
un MCP. Proposition : un MCP de contrôle companions.build disponible dans chaque Companion,
distinct des MCP fournisseurs connectés. Les noms précis des outils ne sont pas encore fixés.

Couverture fonctionnelle requise :

| Domaine | Opérations à couvrir |
| --- | --- |
| Companions | Consulter, créer et modifier mission, instructions, modèle et configuration autorisée ; gérer leur cycle de vie |
| Skills | Lister, installer, modifier et retirer les skills sur les Companions/templates autorisés |
| Connexions et plugins | Lister les connexions disponibles, démarrer une connexion, vérifier son état, associer ou retirer les accès autorisés |
| Routines | Créer, consulter, modifier, activer/désactiver, supprimer, tester et consulter les exécutions |
| Triggers | Configurer une source, la consigne, le mode direct ou le filtre en code ; tester sans déclencher, activer/désactiver, supprimer et consulter les décisions/exécutions |
| Délégation | Découvrir les destinataires autorisés, confier une tâche, suivre son état, récupérer son résultat et demander son annulation |
| Réplicats | Lancer depuis un template autorisé, suivre, arrêter et récupérer les résultats |
| Templates | Créer, consulter et modifier la configuration ; proposer/promouvoir une Box enfant, suivre la capture, choisir une version prête ou revenir à une version précédente |
| Bureau | Demander l'ouverture du bureau, préparer une intervention humaine et suivre la prise/restitution du contrôle |
| Livraison et maintenance | Préparer une livraison, inviter le client et gérer les accès explicitement autorisés ; la sémantique de propriété reste à décider |
| État du produit | Lire les réglages effectifs, capacités disponibles et résultats des opérations, afin de ne pas annoncer une configuration non appliquée |

L'interface web et le MCP passent par les mêmes services métier ; aucune seconde implémentation
des règles, aucun changement exigeant de cliquer dans l'interface lorsqu'une opération agent est
autorisée. Les opérations longues retournent une identité et un état consultable. Une répétition
après timeout ne crée pas une seconde routine, un second trigger ou un second réplicat. L'agent
dispose d'opérations de lecture aussi complètes que les mutations pour vérifier ses changements.

Les droits du MCP sont ceux accordés au Companion et au compte concerné. L'agent peut gérer une
autorisation lorsque l'utilisateur lui a accordé ce pouvoir ; il ne peut pas s'octroyer lui-même
des droits supplémentaires. Un enfant n'hérite pas implicitement de la capacité de répliquer ou
de modifier les templates de son parent. Les capacités réellement accessibles sont découvrables.

Le MCP conduit les procédures qui comportent une étape humaine : il commence la connexion OAuth,
fait apparaître l'action de connexion dans le chat et reprend lorsque le consentement est confirmé.
Il peut demander l'ouverture du bureau, mais ne simule pas le clic ou l'authentification de
l'utilisateur. Un consentement fournisseur, une saisie de paiement ou une authentification humaine
requise reste réalisé par la personne ; la suite est prise en charge automatiquement. La facturation
détaillée reste différée et aucun nouvel écran de gestion financière n'est spécifié ici.

L'agent doit pouvoir configurer un filtre de webhook, mais le chemin de réception du webhook
n'appelle pas cet agent : le filtre enregistré s'exécute sans LLM. Contrôler le bureau lui-même
(souris/clavier, navigateur) relève des outils présents dans la Box ; le MCP produit organise
l'accès et le partage du contrôle.

Exemple de demande : « Quand la CI échoue sur main, lance une analyse, utilise le template
Développeur si nécessaire et propose une correction. » L'agent vérifie les connexions existantes,
crée le trigger et son filtre, teste la règle et configure les délégations qu'il est autorisé à
gérer. Il demande uniquement les accès ou décisions réellement manquants. Le résultat apparaît
dans la fiche du Companion et peut aussi être modifié depuis celle-ci.

## Interface proposée

- Une colonne discrète de Companions persistants et l'action de création.
- Un chat central : messages, fichiers, résultats et activité repliable.
- Un accès au bureau interactif depuis le chat, dans un onglet dédié pour le parcours VNC.
- Une fiche latérale : mission, skills, connexions, routines/triggers et spécialistes autorisés.
- Les templates sont accessibles depuis la création et la sélection de spécialistes. Leur gestion
  ne demande pas une marketplace ni un éditeur visuel de workflows.
- Les enfants apparaissent sous la tâche de leur parent. Leur détail reste consultable après leur
  suppression ; une politique de conservation sera définie séparément.

Les états parlent du travail : démarrage, en cours, besoin de toi, terminé, interrompu ou échec.
Les termes techniques du moteur et de l'infrastructure restent dans les diagnostics.

## Décisions fonctionnelles à explorer ensuite

Le bureau interactif et les triggers directs/filtrés par code sont confirmés. Le premier scénario
client réel permettra de choisir les premières intégrations plutôt que de construire un catalogue
complet. Réseau ou état persistant pour les filtres, contrôle humain du bureau et permissions de
promotion des profils navigateur restent à préciser selon les usages.
