# Harness de l’agent de discussion

Recherche du 11 septembre 2026. Sources primaires consultées à cette date ; aucune dépendance installée, aucun benchmark ni changement de runtime effectué. Les recommandations ci-dessous sont des conclusions d’architecture, pas des capacités déjà implémentées.

## Décision proposée

**Évaluer en premier AI SDK Core / `ToolLoopAgent`, exécuté dans le serveur Bun existant, pour le nouvel agent de discussion. Conserver Pi et la machine persistante des compagnons.** Le client reste React/Vite. Next.js n’est nécessaire pour aucun de ces choix : Vite construit l’interface ; la boucle LLM et les outils autorisés vivent côté serveur.

Le critère est l’adéquation à une conversation Web avec des outils métier : streaming vers React, configuration explicite des outils, fournisseurs interchangeables et contexte par discussion. Ce n’est pas une affirmation qu’AI SDK consomme moins de mémoire ou répond plus vite que Pi. Son modèle d’agent et ses primitives UI correspondent directement au besoin. [Agents AI SDK](https://ai-sdk.dev/docs/agents/overview), [référence ToolLoopAgent](https://ai-sdk.dev/docs/reference/ai-sdk-core/tool-loop-agent).

Périmètre confirmé par l’entretien : l’agent central coordonne les compagnons, sans machine personnelle ni mémoire entre discussions. Il peut leur transmettre des apprentissages. Chaque compagnon conserve sa machine, ses connexions et ses fichiers communs, avec des historiques séparés. Les installations bénéficient à toutes ses discussions. Les dossiers organisent les discussions indépendantes et définissent les compagnons accessibles par défaut. Les spécialistes, routines et déclenchements automatiques sont retirés du cadrage ; le coding est hors sujet.

## Ce que possède réellement le dépôt

- Bun **1.4.2** et Pi **0.85.0** sont épinglés dans [package.json](/Users/stan/.codex/worktrees/ed16/companions.build/package.json). Le serveur utilise `Bun.serve` dans [api.ts](/Users/stan/.codex/worktrees/ed16/companions.build/apps/server/src/api.ts:216).
- React **19.1.1**, Vite **7.1.4** et `ai: ^7.0.93` figurent dans [le manifeste Web](/Users/stan/.codex/worktrees/ed16/companions.build/apps/web/package.json). [Le lockfile Web](/Users/stan/.codex/worktrees/ed16/companions.build/apps/web/bun.lock) résout `ai` en **7.0.93**. Sa présence actuelle sert aux types `UIMessage` des AI Elements ; ce n’est pas encore une intégration de la boucle serveur ou de `useChat`.
- La session actuelle du compagnon est construite avec `createAgentSession`, les outils de machine et un `SessionManager` local dans [pi-executor.ts](/Users/stan/.codex/worktrees/ed16/companions.build/packages/agent/src/pi-executor.ts:201). Ce chemin reste celui des compagnons.
- L’autorisation, l’admission et la facturation de la passerelle modèle sont liées aux runs de compagnons dans [model-gateway.ts](/Users/stan/.codex/worktrees/ed16/companions.build/apps/server/src/model-gateway.ts:169). **Chaque candidat nécessite un chemin de run central correctement autorisé et facturé.** Le choix d’AI SDK ne fournit pas cela automatiquement ; Pi ne l’évite pas non plus.

Les métadonnées éditeur du registre indiquent, au moment de la recherche, `ai` **7.0.97**, Pi **0.85.1** et OpenAI Agents **0.18.0**. La comparaison Pi utilise les sources épinglées **0.85.0** ; les pages AI SDK décrivent la v7 courante, dont les signatures doivent être vérifiées contre **7.0.93** lors de la preuve. Aucune mise à jour n’est proposée ici. [AI SDK](https://registry.npmjs.org/ai/latest), [Pi](https://registry.npmjs.org/@earendil-works/pi-coding-agent/latest), [OpenAI Agents](https://registry.npmjs.org/@openai/agents/latest).

## Comparaison ciblée

| Option | Ce qu’elle apporte | Travail propre à companions.build | Appréciation |
| --- | --- | --- | --- |
| **AI SDK `ToolLoopAgent` / Core** | Boucle outils, streaming, conditions d’arrêt, préparation du contexte ; primitives de messages et transport React. | Outils métier, historique PostgreSQL, suivi durable des délégations, adaptation de la passerelle et intégration UI. | Premier candidat pour le nouvel agent Web. |
| **Pi `pi-agent-core` 0.85.0** | Boucle embarquable, outils explicites, événements, annulation, steering, adaptation du contexte et fournisseurs Pi. | Transport UI, persistance centrale, compaction choisie par l’application, délégations durables. | Alternative sérieuse si réutiliser les formats et fournisseurs Pi réduit sensiblement l’intégration. |
| **Pi `createAgentSession` 0.85.0** | Couche plus complète : sessions, historique, extensions, compaction, événements. | Neutraliser découverte des ressources/outils de machine et adapter son stockage au rôle central. | Possible sans Box ; davantage de conventions de l’agent de machine à encadrer. |
| **OpenAI Agents SDK TS** | Runner, outils, streaming, sessions personnalisables, état de run reprenable, modèles OpenAI et adaptateurs tiers. | Backend PostgreSQL, transport UI et protocole de tâches distantes ; passerelle et règles de reprise. | Solide, mais ajoute un troisième ensemble de formats sans avantage décisif démontré ici. |

Sources de la comparaison : [AI SDK Core](https://ai-sdk.dev/docs/reference/ai-sdk-core/tool-loop-agent), [persistance et React](https://ai-sdk.dev/docs/ai-sdk-ui/chatbot-message-persistence), [Pi agent-core 0.85.0](https://github.com/earendil-works/pi/blob/v0.85.0/packages/agent/README.md), [Pi SDK 0.85.0](https://github.com/earendil-works/pi/blob/v0.85.0/packages/coding-agent/docs/sdk.md), [OpenAI sessions](https://openai.github.io/openai-agents-js/guides/sessions/), [OpenAI modèles](https://openai.github.io/openai-agents-js/guides/models/), [OpenAI streaming](https://openai.github.io/openai-agents-js/guides/streaming/).

**Pi n’exige pas une machine dédiée.** `pi-agent-core` reçoit une liste d’outils et une fonction de streaming ; il peut donc n’exposer que nos API métier. Sa transformation de contexte permet filtrage et résumé, mais ce n’est pas la compaction automatique de `AgentSession`. Les interfaces de session de Pi exposent aussi une variante en mémoire. Le choix se fait sur le coût d’intégration, pas sur une impossibilité de déployer Pi côté serveur. [Agent-core](https://github.com/earendil-works/pi/blob/v0.85.0/packages/agent/README.md), [SDK](https://github.com/earendil-works/pi/blob/v0.85.0/packages/coding-agent/docs/sdk.md).

Pour AI SDK, `prepareStep` permet d’adapter les messages, et `pruneMessages` de retirer certains éléments ; une politique de résumé et ses seuils restent à choisir. L’historique intégral doit rester consultable indépendamment du contexte envoyé au modèle. OpenAI propose un backend `Session` personnalisé et une compaction via Responses ; cette dernière dépend de l’API OpenAI. Aucun apprentissage interdiscussions n’est nécessaire. [Contrôle de boucle AI SDK](https://ai-sdk.dev/docs/agents/loop-control), [sessions OpenAI](https://openai.github.io/openai-agents-js/guides/sessions/).

Les pièces jointes et la recherche Web nécessitent un choix explicite de modèle et d’outils : la bibliothèque n’accorde pas spontanément ces capacités. Un fournisseur direct peut remplacer AI Gateway dans AI SDK. Le support Bun de la combinaison exacte choisie, notamment son adaptateur modèle et son streaming, reste à prouver dans notre distribution ; un exemple Node n’est pas ce test. [Démarrage AI SDK](https://ai-sdk.dev/docs/getting-started/nodejs), [modèles OpenAI Agents](https://openai.github.io/openai-agents-js/guides/models/).

## La frontière essentielle : historique, flux et exécution

`ToolLoopAgent` vit en mémoire. Sauvegarder des messages ne sauvegarde pas un processus ; reconnecter un flux ne garantit pas la survie des outils après crash. AI SDK documente une reprise de flux avec stockage externe et endpoints dédiés ; fermer la connexion et annuler le travail sont deux opérations distinctes. [Reprise des flux](https://ai-sdk.dev/docs/ai-sdk-ui/chatbot-resume-streams).

AI SDK propose désormais aussi **`WorkflowAgent`**, avec persistance et reprise par étapes. Il exige `@ai-sdk/workflow` et Workflow 5, actuellement sous le tag beta, et ajoute des retries d’outils. C’est une option à évaluer si un moteur durable général devient nécessaire, mais pas un raccourci qui dispense de traiter une délégation déjà acceptée avant une panne. Son intégration au serveur Bun actuel n’a pas été testée. [Documentation WorkflowAgent](https://ai-sdk.dev/docs/agents/workflow-agent).

Architecture proposée :

1. Persister le message utilisateur et le run central avant l’appel modèle.
2. Un outil `delegate` persiste une demande avec identifiant stable, puis rend rapidement son identifiant et son état. L’exécuteur réalise l’envoi au compagnon selon le protocole durable existant.
3. L’agent central termine son tour et peut répondre à d’autres messages pendant la tâche. Il ne conserve pas un appel d’outil bloqué pendant plusieurs minutes.
4. Un résultat du compagnon est persisté, dédupliqué et associé à la discussion avant sa présentation. Une continuation du coordinateur utilise cet événement et l’historique actualisé.
5. Après reconnexion ou redémarrage, reconstruire l’affichage depuis PostgreSQL et réconcilier les tâches par leur identifiant. Une exécution ambiguë est signalée et examinée, jamais automatiquement relancée.

Ce protocole est une proposition fondée sur les invariants du [AGENTS.md](/Users/stan/.codex/worktrees/ed16/companions.build/AGENTS.md), pas une fonctionnalité fournie par un SDK. Le résumé d’arrivée d’un compagnon, l’accès à l’historique, le retrait sans annulation et la transmission d’apprentissages sont des outils et règles métier, communs aux trois candidats.

## `pi-background-tasks` : utile du côté compagnon

La version **2.5.0** examinée permet de lancer une commande locale nommée avec `bg_run`, de recevoir un identifiant et de consulter ou arrêter le travail. Son bus publie des événements de fin dont le consommateur doit dédupliquer les notifications. `bg_delegate` lance un enfant Pi local destiné à l’inspection ; il ne correspond pas à l’appel de nos compagnons existants. **Le candidat concerne les commandes longues sur leur machine**, pas le harness central ni la prise de main sur le desktop. [README au commit examiné](https://github.com/ismailsaleekh/pi-background-tasks/blob/14aa4ef382952f073bd4d540f57d6e8e3c2789a2/README.md).

Deux conditions empêchent de le considérer prêt à installer : le manifeste déclare Node ≥22.19.0 et des peer dependencies Pi allant jusqu’à `^0.84.0`, qui excluent notre **0.85.0** ; il ne déclare pas Bun. Le chargement par défaut inclut également une extension d’attribution Anthropic, dont la configuration documente l’usage d’OAuth d’abonnement et le rejet de credentials Anthropic facturés à l’usage. Il faut vérifier l’effet sur notre passerelle avant adoption. [Manifeste](https://github.com/ismailsaleekh/pi-background-tasks/blob/14aa4ef382952f073bd4d540f57d6e8e3c2789a2/package.json), [configuration](https://github.com/ismailsaleekh/pi-background-tasks/blob/14aa4ef382952f073bd4d540f57d6e8e3c2789a2/docs/operations/configuration.md).

Le mécanisme « je prends la main » reste un contrat distinct : propriétaire identifié pour le desktop partagé, état visible et libération de la main. Des commandes en arrière-plan peuvent continuer. Le contrôle de cet accès doit être effectif côté outils ; une phrase dans le chat ne suffit pas. Sa réalisation détaillée et la concurrence entre nombreuses discussions sont reportées, comme demandé.

## Preuve minimale avant choix définitif

Un prototype borné d’AI SDK sur Bun doit démontrer : deux historiques indépendants ; chat et pièce jointe avec le fournisseur prévu ; délégation avec accusé durable immédiat ; discussion encore disponible pendant le travail ; résultat retrouvé après déconnexion puis redémarrage ; doublon sans deuxième tâche ; annulation et panne ambiguë représentées honnêtement. Vérifier également la compaction, les permissions et la mesure des usages centraux.

Mesurer temps au premier token, mémoire par discussion active et surcoût du démarrage sur cette preuve, sans promettre un gain avant mesure. Si l’adaptation de la passerelle ou du transport annule le bénéfice d’AI SDK, refaire le même petit scénario avec `pi-agent-core` 0.85.0. Pour `pi-background-tasks`, une preuve séparée dans le runtime Linux compilé devra couvrir compatibilité, propriété des tâches et livraison du résultat à la bonne discussion.
