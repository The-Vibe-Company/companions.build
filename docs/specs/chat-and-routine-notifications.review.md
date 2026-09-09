# Spec Review

> Suivi de révision : Stan a validé les indicateurs sur les avatars des autres Companions.
> La spec a ensuite été complétée sur l'ordre d'arrivée, les questions terminales, la
> migration/rollback, le détail MCP, les segments thinking et les tests adverses. Le texte
> de revue ci-dessous est conservé comme constat de la version initiale ; ses numéros de
> lignes se rapportent à cette version. Ce suivi n'est pas une seconde approbation : le
> raccordement technique de la notification agent reste non vérifié.

## Verdict

Status: blocked

Reason: la direction produit est validée, mais le raccordement des messages adressés à
l'agent principal n'est pas établi dans ce checkout. Plusieurs contrats de comportement
restent trop vagues pour garantir la stabilité promise. Ce verdict porte sur la préparation
à l'implémentation, pas sur l'intérêt de la refonte.

Revue du 9 septembre 2026, fondée sur la spécification et une lecture du code local.
Aucun test live, aucune vérification des versions déployées et aucune modification de la
spécification ou du code applicatif n'ont été réalisés pendant cette revue.

## Highest-Risk Issues

1. **P1 — La destination agent n'a pas de contrat technique identifié.**
   La spec, lignes 73 et 175–176, exige un message reçu par l'agent principal.
   `pi-executor.ts` configure `publish_to_chat` pour sélectionner une publication humaine ;
   `executor.ts:57` la matérialise dans `messages`. Le retour de délégation observé dans
   `lifecycle.ts:320` crée une tâche parent en lane background, ce qui ne prouve pas une
   injection dans le chat principal. Stan indique que la capacité existe : retrouver son
   point d'entrée, sa version et son chemin jusqu'à Pi, puis documenter identité durable,
   admission et état de réception. Ne pas demander à Stan de redéfinir Pi, ne pas conclure
   que la capacité est absente, et ne pas remplacer implicitement ce besoin par un bouton.

2. **P1 — « Ordre stable » ne tranche pas l'arrivée tardive des événements.**
   Spec, lignes 111–125 et 183. Les commentaires ont des séquences par run, mais une
   question, un steer humain et une carte serveur peuvent arriver entre deux observations
   de l'agent. Un timestamp, même durable, ne suffit pas à garantir à la fois chronologie
   réelle et absence de déplacement lorsque des événements sont reçus en retard.
   Il faut décrire les frontières entre ordre causal Pi, ordre d'admission serveur et
   rattachement visuel. Ajouter un exemple avec deux steers et une carte reçue tardivement,
   ainsi que le résultat attendu en direct et après reload. Ne pas garantir une association
   « pris en compte » au simple accusé d'acceptation serveur.

3. **P1 — Les questions terminales peuvent rester faussement actionnables.**
   Spec, lignes 91–94 et 163–166. « Répondu » et « non répondu » ne couvrent pas une tâche
   annulée, interrompue ou terminée sans réponse humaine. L'API expose actuellement
   `runStatus` avec les questions (`apps/server/src/api.ts:181`). Définir une question
   actionnable à partir de son état et de celui de la tâche ; fermer son indicateur lors
   d'un état terminal et garder l'historique avec sa raison. Prévoir une course entre
   réponse, annulation et autre onglet. Un accusé de réponse n'est pas une preuve que
   l'exécution a déjà repris.

4. **P1 — Migration et rollback sont des objectifs, pas encore un chemin vérifiable.**
   Spec, lignes 205–219 et 236–239. Les publications humaines sont actuellement des
   messages assistant attachés à un run ; les nouvelles notifications auront d'autres
   états. Définir comment sélectionner les anciennes publications de routines, préserver
   texte/fichiers, empêcher un doublon entre fil et panneau et garder les questions ouvertes.
   La règle provisoire « anciennes notifications déjà lues » doit être explicite au moment
   du basculement. Préciser quelle version précédente sait lire les données nouvelles ou
   quel adaptateur assure l'accès : conserver les lignes en base ne garantit pas leur
   visibilité après rollback. Tester un déploiement mixte et un rollback avec question ouverte.

5. **P2 — Le panneau peut cacher une demande sur un autre Companion.**
   Spec, lignes 83–94. Le bouton et Besoin de toi sont locaux au Companion ouvert.
   L'utilisateur présent sur un autre Companion ou sur l'accueil n'a aucun chemin défini
   pour découvrir une demande. Décision produit à prendre : signal discret sur les avatars
   de la navigation, ou notifications volontairement limitées au Companion consulté.
   Un centre global et des notifications push ne sont pas nécessaires pour combler ce trou.

6. **P2 — Le niveau de détail MCP et le thinking restent insuffisamment spécifiés.**
   Spec, lignes 106–114 et 146–155. `plugin_call` dispose de l'identité de connexion et du
   nom d'outil ; tous les outils personnalisés n'offrent pas un libellé humain ou une
   qualification fiable lecture/écriture. Définir un fallback factuel et les champs
   autorisés dans le détail. Ne pas déduire une réussite du transport : le chemin actuel
   expose aussi `details.isError` (`packages/plugins/tools.ts`). Par ailleurs,
   `pi-executor.ts:238–254` remplace un seul `thinkingText` au fil des messages : fixer
   sa position ne conserve pas les segments précédents. Spécifier une conservation par
   segment/message et une présentation groupée éventuelle, ou reconnaître explicitement
   la limite. Vérifier plusieurs cycles commentaire → outil → thinking → réponse.

## Product Review

- Strengths: séparation utile entre conversation, notification et activité ; pas de
  succès simulé ; commentaires conservés ; fonctionnement de Pi respecté.
- Gaps: visibilité hors du Companion actif ; les notifications d'échec ne définissent
  pas encore le traitement des états interrupted, cancelled et des occurrences manquées.
- Required changes: compléter une matrice de tous les états réels. Proposition technique
  à soumettre dans la révision : annulation volontaire et occurrence manquée restent dans
  l'activité ; interruption anormale produit une notification sans rejouer le travail.

## UX Review

- Strengths: panneau durable, aperçu sans focus volé, séparation lu/résolu et clavier/mobile.
- Gaps: aucun exemple visuel commun du fil avant/pendant/après ; comportement du scroll
  et du panneau vide absent ; sort de la saisie lors de la fermeture du panneau non défini.
- Required changes: préserver l'ancrage lorsque l'utilisateur lit plus haut, montrer un
  accès aux nouveaux éléments sans forcer le bas ; restaurer le focus à la fermeture ;
  définir le brouillon de réponse par question et des libellés pour question résolue,
  annulée ou envoi encore incertain. Fixer lecture et comptage au niveau des occurrences
  pour qu'un nouvel échec ajouté à un groupe déjà lu reste effectivement non lu.

## Engineering Review

- Strengths: PostgreSQL, identités durables, déduplication, propriétaires et absence de replay.
- Gaps: identité commune des événements de plusieurs sources, contrat de notification
  agent, interprétation des états et compatibilité des anciennes publications.
- Required changes: formaliser ces contrats avec exemples avant implémentation. Prévoir
  pagination du panneau et compteurs calculés indépendamment de la page chargée ; ne pas
  ajouter l'historique complet des notifications à chaque snapshot du chat.

## QA Review

- Strengths: critères observables, tests de reconnexion et réutilisation du test de
  conservation déjà présent ; prudence sur le diagnostic du bug signalé.
- Gaps: absence de traces attendues pour arrivée tardive, questions terminales,
  réouverture des groupes lus, lecture multi-onglet, rollback et MCP en erreur applicative.
- Required changes: ajouter ces scénarios avec états et ordre attendus, incluant ancien
  runtime sans détails. Une simple capture après complétion ne démontre pas l'absence
  de déplacement pendant l'exécution. Reproduire les disparitions avant d'en annoncer
  une cause. Ne pas créer de tests qui ne font que recopier un ordre de tableau statique.

## Scope Review

- Scope creep: le risque serait de transformer cette refonte en moteur de notifications
  global ou en nouveau scheduler pour l'agent principal.
- Missing non-goals: expliciter le traitement inchangé des triggers et délégations, dont
  les chemins de publication peuvent partager le code des routines ; pas d'extension
  accidentelle du routage à toutes les lanes background.
- Suggested cuts: pas de push/email, pas de centre global, pas d'analyse LLM des noms
  d'outils pour afficher un libellé. Conserver la capacité existante de notification agent.

## Questions Before Planning

**Décision produit unique à prendre :** faut-il signaler les non-lues et demandes
Besoin de toi sur l'avatar d'un Companion que l'utilisateur n'est pas en train de consulter ?
Recommandation : oui, avec un indicateur discret qui ouvre son panneau, sans ajouter de
message au fil courant ni de centre global.

Les contrats techniques des points 1–4 relèvent de l'investigation et de la révision ;
ils ne doivent pas être reportés sur l'utilisateur sous forme de choix de fonctionnement Pi.
La réponse à cette question produit ne suffit pas, seule, à lever le verdict bloqué.

## Required Spec Edits

1. Ajouter la référence vérifiée du chemin existant de notification agent, sans redéfinir Pi.
2. Décrire l'ordre observable avec événements tardifs, steers concurrents et segments thinking.
3. Ajouter le cycle de vie complet des questions et une matrice des états de routine.
4. Rendre migration, versions mixtes et rollback exécutables et testables.
5. Ajouter la visibilité entre Companions selon la décision produit, l'ancrage du scroll,
   les états du panneau, les brouillons et la sémantique exacte des non-lues.
6. Fixer les détails MCP autorisés, les fallbacks, erreurs et limites de pagination.
7. Compléter les critères d'acceptation par les scénarios adverses identifiés ci-dessus.

## Handoff

Use this for planning only if verdict is ready or needs revision with non-blocking issues:

- Approved scope: direction produit de la refonte validée ; pas encore prête à planifier.
- Required issues: aucun ticket créé ou proposé à publication dans cette revue ; réviser
  la spec selon les sept corrections avant de découper l'implémentation.
- Risks to track: confusion humain/agent, ordre visible instable, questions fantômes,
  historique inaccessible, notifications hors champ et résultats MCP trompeurs.
- Tests to include: arrivée tardive, double steer, annulation/réponse concurrentes,
  lecture multi-onglet, nouveau groupe non lu, migration/rollback et MCP isError.
- Open non-blockers: durée exacte de l'aperçu, dimensions du panneau et détails visuels
  à éprouver dans la maquette ; aucune de ces finitions ne remplace les contrats manquants.
