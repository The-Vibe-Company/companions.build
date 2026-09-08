# Spec Review

## Verdict

Status: ready

Reason: prête pour le découpage d'implémentation après révision, pas pour déploiement.
Le propriétaire a délégué les arbitrages après la première revue. Les sections 8 et 9 de la
spécification fixent le passage de relais sous quota, les installations bornées, la capture,
les propositions applicables, l'init ambiguë, les identités et les règles fournisseur.
Les constats initiaux ci-dessous sont conservés pour traçabilité ; leur correction doit être
prouvée par l'implémentation et ses tests. Aucune preuve live n'a été réalisée.

### Résolution de la revue

| Constat initial | Décision intégrée |
| --- | --- |
| Quota=1 bloque le test | Archiver le brouillon, confirmer la place libérée, tester, puis reprendre sous quota |
| Installations système indéfinies | Demande structurée vers helper borné ; pas de sudo pour Pi ; alternatives explicites |
| Conservation des versions | Snapshot nommé par version et références durables ; pas d'expiration inventée à sept jours |
| Améliorations opaques | Recettes et fichiers sélectionnés ; application sur copie ; reconstruction assistée si nécessaire |
| Init ambiguë | Pas de mission concurrente avec un init d'état inconnu ; arrêt confirmé avant poursuite |
| Identité héritée | Retrait des identités et credentials gérés par le produit dans l'image dérivée uniquement |

La documentation officielle a finalement été accessible par lecture HTTP directe :
[rétention et copies](https://docs.ascii.dev/box/snapshots.md),
[limites](https://docs.ascii.dev/box/billing.md),
[TTL](https://docs.ascii.dev/box/long-running-tasks.md).
Les quotas incluent les reprises ; leurs valeurs effectives et la politique de rétention du
compte réel restent des vérifications avant activation. Les offres commerciales peuvent être
ajustées sans bloquer le découpage. Le rollout place désormais admission et cycle de vie en premier.

Revue du 7 septembre 2026 de [la spécification](specialists-configuration-and-lifecycle.md).
Lecture croisée du cycle de vie, du client Box, de la délégation, des templates et de l'ADR
logiciels. Aucun code produit n'a été modifié ; la spécification a été révisée après l'instruction
« décide ». Les sections suivantes décrivent le constat initial, avant cette révision.

## Highest-Risk Issues

1. **P1 — Le test peut attendre une place que son propre brouillon occupe.**
   Les lignes 89–93 créent une nouvelle VM d'essai ; les lignes 180–192 comptent le brouillon
   dans le quota mais ne définissent l'archivage anticipé que pour les interventions inactives.
   Avec un plafond de 1 et une configuration encore ouverte, aucun passage de relais n'est défini.
   Une VM de capture ou d'application d'amélioration pourrait rencontrer le même problème.
   **Correction proposée :** figer l'état testé, suspendre/archiver le brouillon, confirmer la
   libération de sa place, puis admettre le test. Définir aussi la reprise de configuration,
   les ressources intermédiaires comptabilisées et la fin de vie des brouillons inactifs.

2. **P1 — L'installation autonome promise ne dispose pas d'un chemin d'exécution défini.**
   Les lignes 76–84 promettent la préparation des outils. Or [le cycle de vie](../lifecycle.md)
   exécute Pi sans sudo, et [l'ADR logiciels](../adr/portable-software.md) décrit un helper
   privilégié que Pi ne peut pas invoquer, avec un catalogue/manifest borné. Une demande de
   paquet système peut donc rester impossible malgré une VM disponible.
   **Correction proposée :** définir un outil de demande d'installation traité par l'exécuteur,
   avec logiciels pris en charge, droits et état de résultat ; distinguer installations en espace
   utilisateur et système. Ne pas résoudre cela en donnant implicitement sudo à Pi ou en utilisant
   le terminal graphique pour contourner sa frontière d'exécution.

3. **P1 — Archive d'intervention et version publiée n'ont pas le même contrat de conservation.**
   Les lignes 100–109 promettent une base immuable réutilisable, tandis que les lignes 169–172
   admettent une rétention fournisseur bornée. Une version publiée doit rester disponible même
   quand son brouillon et ses interventions ont expiré. Le [client Box](../../packages/box/client.ts)
   distingue déjà arrêt de machine et snapshot nommé, avec une erreur de limite de snapshots.
   **Correction proposée :** définir la propriété, la rétention, les références et la suppression
   des images publiées, des brouillons et des sources d'amélioration séparément. Prévoir le cas
   « quota de snapshots atteint » sans perdre la publication précédente.
   La [page officielle Box](https://box.ascii.dev/) confirme que l'arrêt suspend la facturation et
   conserve les fichiers/paquets ; elle ne suffit pas à établir ici sept jours de rétention ni les
   quotas horaires. L'accès à l'index documentaire a échoué lors de cette revue. Ces faits restent
   à vérifier, sans les faire arbitrer par l'utilisateur comme des préférences produit.

4. **P1 — Une amélioration de VM n'est pas encore un changement applicable.**
   Les lignes 149–160 prescrivent de réappliquer les changements sur un brouillon plus récent,
   sans définir ce qu'une proposition conserve au-delà du disque source et d'un résumé.
   Exemple : une intervention ajoute un paquet système, une autre modifie un skill ; la seconde
   image complète ne permet pas à elle seule de préserver la première amélioration.
   **Correction proposée :** conserver une recette d'installation et les changements identifiables
   de fichiers/configuration, leur base et leur résultat. Les changements opaques passent par une
   reconstruction assistée dans le brouillon. Une carte ne promet pas « appliquer » si seul un
   résumé subsiste ; distinguer proposition transposable, conflit et source expirée.

5. **P1 — Une initialisation ambiguë peut encore tourner quand la mission démarre.**
   Les lignes 138–142 distinguent l'échec de l'ambiguïté, mais les lignes 251 et 329–330 ne
   disent pas quand la mission peut effectivement commencer après perte de réponse ou timeout.
   Un script peut continuer à modifier le dépôt pendant que Pi travaille dessus.
   **Correction proposée :** distinguer échec terminal connu, processus encore actif et état
   indéterminé. L'échec terminal permet la mission ; un processus actif doit être suivi ou arrêté
   de façon confirmée. Une ambiguïté ne devient pas un échec par simple expiration d'un délai.
   Préserver le non-rejeu et prévoir l'information du parent ainsi qu'une borne d'exécution.

6. **P1 — La promesse d'isolation n'inclut pas explicitement l'identité technique de la source.**
   Les lignes 100–104 excluent historiques et MCP, mais l'image doit également perdre les
   identifiants propres au runtime source et les paramètres de services qui pourraient le
   reconnecter comme cet agent. Les connexions fournies par la plateforme pour git/les scripts
   doivent être distinguées des sessions Chrome que l'utilisateur a choisi de conserver.
   **Correction proposée :** inventorier uniquement les chemins/identités gérés par le produit,
   les retirer de l'image dérivée et recréer l'identité de chaque copie. Cela respecte la décision
   de ne pas scanner arbitrairement les secrets utilisateur. Tester une copie entre propriétaires
   avec un runtime source encore existant, pas seulement l'absence de transcript.

## Product Review

- Strengths: distinction Companion/spécialiste/intervention nette ; publication humaine ; cas
  GitHub/Linear concret ; test facultatif et amélioration visible dans le chat parent.
- Gaps: le texte qualifie trop vite certains points de « conception technique », alors qu'ils
  changent ce que peut accomplir l'utilisateur : reprise du brouillon, installation système,
  application d'une proposition, conservation d'une version.
- Required changes: préciser ces contrats sans rouvrir les décisions validées, notamment la
  conservation volontaire de sessions navigateur et l'absence de test obligatoire.

## UX Review

- Strengths: cartes de connexion dans le chat, configuration visible, états persistés, reprise
  après rechargement, distinction préparation/test/publication.
- Gaps: aucune étape claire lorsque le test prend la place de la configuration ; publication
  pendant un shell ou une interaction desktop encore active ; première publication suivie de
  l'ajout à l'équipe ; comportement de « résultat satisfaisant » non décrit.
- Required changes: montrer le passage configuration → test → retour, la capture en cours et
  les conflits d'édition. Définir qui juge le test, et proposer l'ajout à l'équipe après publication.
  Un simple changement de génération en base ne détecte pas une modification du disque par Chrome
  ou un processus : prévoir une capture cohérente des fichiers effectivement vérifiés/testés.

## Engineering Review

- Strengths: intention avant effet, exécuteur seul, idempotence, états observés distincts,
  publication atomique et réservations concurrentes sont des exigences explicites.
- Gaps: FIFO strict contre MCP manquant en tête de file ; durée de vie d'un maintien explicite
  face à une reprise de Pi ; signal d'activité perdu ; accès git/script issu d'une connexion MCP ;
  retrait de permission d'équipe pendant l'attente ; réveil d'une archive non décrit par l'admission.
- Required changes: adopter une règle explicite pour les demandes temporairement inéligibles,
  revalider permissions et comptes au lancement, et faire passer les réveils par le plafond actif.
  Distinguer quota de création et quota d'activité. Coordonner l'inactivité avec le TTL fournisseur :
  le client actuel demande 21 600 secondes à la création/reprise, ce qui ne prouve pas un maintien
  illimité tant que Pi travaille. Confirmer ou renouveler ce TTL sans rejouer la tâche.

## QA Review

- Strengths: couverture des crashs, duplications, isolation et erreurs fournisseur adaptée aux risques.
- Gaps: pas de scénario quota=1, snapshot saturé, script encore actif après timeout, réveil en compte
  saturé, génération modifiée sur disque pendant capture, ni migration de livraison déjà engagée.
- Required changes: ajouter ces scénarios comportementaux ; vérifier aussi qu'une demande sans
  MCP n'affame pas la file, et qu'une proposition valide ne disparaît pas à l'archivage de sa source.
  Le test navigateur doit prouver le parcours complet sans promesse d'installation fictive.

## Scope Review

- Scope creep: onboarding, primitives privilégiées, partage de disque, améliorations, ordonnancement
  et offres représentent plusieurs chantiers ; ce n'est pas une simple refonte du formulaire.
- Missing non-goals: préciser que les recettes d'amélioration ne constituent pas une fusion
  universelle de disques et que choisir un dépôt n'accorde pas implicitement tous les droits GitHub.
- Suggested cuts: garder tous les résultats produit validés, mais séquencer les livraisons avec
  l'admission et la préparation vérifiable avant ouverture de l'onboarding. Conserver les aperçus
  hors périmètre. Ne pas différer l'amélioration en tant que valeur produit ; borner son mécanisme.

## Questions Before Planning

Décision utilisateur prioritaire : accepter que lancer un test mette la configuration en pause
et cède sa place à la copie d'essai lorsque le quota est saturé.

Les autres corrections doivent être préparées techniquement : preuve fournisseur, installation
contrôlée, cycle de capture, format de proposition, init ambiguë et purge des seules identités
produit. Ne demander au propriétaire que les choix qui restent réellement produits après ce travail.

## Required Spec Edits

1. Ajouter les transitions des VM de configuration, d'essai, de capture et de reprise sous quota.
2. Décrire le contrat d'installation réalisable avec les droits actuels ou son évolution explicite.
3. Séparer artefact publié durable, archive temporaire et copie livrée indépendante ; documenter
   les preuves fournisseur et les échecs de capacité/rétention.
4. Définir le contenu applicable d'une proposition et le traitement des modifications opaques.
5. Séparer les états d'initialisation active, terminale et ambiguë avant admission de la mission.
6. Définir la capture cohérente et le retrait des identités/runtime/MCP produit de l'image dérivée,
   sans supprimer le chat du brouillon ni élargir au scan des sessions utilisateur.
7. Préciser FIFO/éligibilité, révocation des permissions, réveil sous quota et TTL fournisseur.
8. Ajouter les tests indiqués et ordonner le rollout pour ne jamais exposer des créations non bornées.

## Handoff

Use this for planning only if verdict is ready or needs revision with non-blocking issues:
- Approved scope: décisions produit de la spécification ; aucun retrait proposé sans validation.
- Required issues: non créés ; découper admission, préparation/capture, onboarding/publication,
  connexions/partage et initialisation/améliorations selon la spécification révisée.
- Risks to track: admission et cycle de vie des machines auxiliaires, rétention, privilèges,
  capture cohérente, identité des copies, changements de VM et ambiguïté d'exécution.
- Tests to include: quota=1, concurrence, reprises, scripts ambigus, copie indépendante, capture
  concurrente, saturation snapshots et péremption des sources.
- Open non-blockers: valeurs commerciales des limites, forme visuelle finale et aperçus futurs.
