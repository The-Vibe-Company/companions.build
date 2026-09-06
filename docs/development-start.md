# Premier chantier : prouver le programme Pi/Bun sur Linux

Statut au 6 septembre 2026 : preuve Pi/Bun Linux exécutée, 11 tests passants.
Voir [les résultats, mesures et limites](research/pi-bun-feasibility-2026-09-06.md).
Le brief ci-dessous conserve le périmètre demandé ; la suite commence par la
spec du premier parcours utilisable, décrite à la fin.

## Référence

Lire [le cadrage produit](companions-build.md), notamment les sections 2 et 13.
Les recherches citées sont dans `research/`. Ce dossier est le nouveau projet,
indépendant de Companion. Les copies présentes ici deviennent les références de
ce projet ; ne pas entretenir deux versions dans l'ancien dépôt.

## Question à résoudre

Peut-on distribuer notre programme TypeScript utilisant le vrai SDK Pi avec Bun,
et le démarrer sur Linux sans installation de dépendances au lancement, tout en
conservant des sessions séparées pour le chat et le travail en arrière-plan ?

## Livrable

Un petit programme expérimental, clairement isolé du futur produit, accompagné
d'une commande de vérification reproductible et d'un rapport de résultats.
Épingler les versions exactes utilisées et conserver le lockfile. Ne pas copier
l'ancien broker, son protocole RPC ou son moteur de progression.

## Preuves attendues

1. Construire la distribution et l'exécuter dans un Linux isolé sans Node, Bun
   ni gestionnaire de paquets préinstallé à l'exécution. Les ressources annexes
   nécessaires doivent être listées et livrées explicitement.
2. Utiliser le vrai Pi SDK et un modèle de test scripté : prompt, appel d'outil
   réel sur fichier, réponse et annulation. Aucun compte modèle payant requis.
3. Garder le chat utilisable pendant une tâche longue dans une autre session,
   sans mélanger les historiques. Vérifier le comportement natif de Pi pour
   les messages reçus pendant le travail.
4. Arrêter le processus puis le relancer avec le même disque : retrouver
   l'historique et les fichiers. Une action dont l'issue est incertaine ne doit
   pas être relancée automatiquement ; décrire ce qui devra être assuré par
   le futur protocole durable de l'application.
5. Charger un skill et exercer un outil MCP de test avec la distribution
   construite, pour détecter les ressources ou exécutables oubliés.
6. Mesurer séparément lancement du processus, disponibilité pour accepter une
   tâche et réponse du modèle scripté. Publier les valeurs brutes, le nombre
   d'essais et l'environnement. La cible de disponibilité est inférieure à
   deux secondes sur une machine déjà disponible ; ce test ne mesure pas la
   création ou le réveil d'une Box chez le fournisseur.

## Boucle de validation pour les agents

Une commande lance la vérification et retourne un code de sortie fiable.
Un échec indique le scénario, les étapes observées, les traces expurgées et la
commande de reproduction. Préserver les traces d'échec. Les processus Linux
et leurs actions système restent dans le conteneur ou la VM de test, jamais
sur le Mac hôte. Aucune dépendance aux clés de production.

## Conclusion exigée

Rapport avec versions, commandes, résultats observés, limitations et verdict :
distribution validée, adaptations nécessaires ou obstacle précis. Un simple
build réussi ne valide ni les outils, ni les ressources, ni les redémarrages.
Si un exécutable unique ne suffit pas, éprouver une distribution figée avec
ses ressources avant de rouvrir le choix du harness.

## Après cette preuve

Rédiger la spec du premier parcours utilisable : créer un Companion depuis un
environnement préparé, lui parler dans le web, exécuter une routine tout en
continuant le chat et retrouver l'état après redémarrage. Découper ensuite en
tickets verticaux, chacun avec une preuve observable, puis implémenter avec
TDD et revue. Les tests locaux reproductibles font partie du premier parcours.

La vision complète reste dans le cadrage : triggers, plugins, bureau,
délégation, templates et livraison client suivront par parcours testables.
Leur absence de cette preuve technique ne les retire pas du produit.
