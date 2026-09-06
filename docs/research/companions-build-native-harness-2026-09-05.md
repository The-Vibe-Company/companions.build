# companions.build — daemon natif, Pi embarqué et alternatives

Recherche au 5 septembre 2026. Périmètre : nouveau produit open source web, Box conservé, chat et routines indépendants, MCP et subagents visibles dans le produit. Cette note n'évalue pas l'ancien runtime et ne propose aucune intégration Skills Hub. Sources primaires : dépôts, manifests, code et documentation officiels consultés aujourd'hui. Aucun benchmark, compilation, appel modèle ou test Box effectué.

## Choix proposé

Deux chemins méritent une preuve exécutable : **TypeScript avec le SDK Pi pour emprunter le plus de comportement existant**, et **Go avec Fantasy pour posséder un daemon natif au périmètre précis**. Rust avec Rig est crédible, particulièrement pour un moteur à checkpoints explicites, mais n'efface pas le travail produit restant. Goose et OpenCode sont des harnesses complets à adopter derrière leur frontière publique plutôt que des petites bibliothèques à découper.

C'est un jugement d'architecture, pas un classement de rapidité. Distribuer un exécutable et écrire le moteur en Go/Rust sont deux décisions différentes : Pi et OpenCode produisent déjà des exécutables avec Bun, en embarquant du JavaScript et son runtime. Cela ne démontre ni la compatibilité de notre futur embedding ni un avantage de latence.

## État vérifié des candidats

Tous les dépôts ci-dessous étaient non archivés et avaient des commits récents. Une activité récente n'est pas une garantie de stabilité API.

| Candidat | Dernière release observée | Licence du projet | Nature |
| --- | --- | --- | --- |
| [Fantasy](https://github.com/charmbracelet/fantasy/releases/tag/v0.43.0) | 0.43.0, 4 septembre | Apache-2.0 | Bibliothèque Go fournisseurs + boucle agent |
| [Rig](https://github.com/0xPlaygrounds/rig/releases/tag/v0.42.0) | 0.42.0, 17 août | MIT | Bibliothèques Rust fournisseurs, exécution et mémoire |
| [Goose](https://github.com/block/goose/releases/tag/v1.49.0) | 1.49.0, 3 septembre | Apache-2.0 | Harness Rust complet, CLI et fonctionnalités produit |
| [Pi](https://github.com/badlogic/pi-mono/releases/tag/v0.85.0) | 0.85.0, 4 septembre | MIT | Couches TypeScript, SDK et CLI |
| [OpenCode](https://github.com/anomalyco/opencode/releases/tag/v1.18.29) | 1.18.29, 4 septembre | MIT | Harness TypeScript avec serveur HTTP et SDK client |

Licences vérifiées dans les sources : [Fantasy](https://github.com/charmbracelet/fantasy/blob/cb378300dd77e7b434d6806b278dc87857a15fd6/LICENSE), [Rig](https://github.com/0xPlaygrounds/rig/blob/d9ed455cf5d0c8f13207ab03c7843982a0f4898e/crates/rig-agent/Cargo.toml), [Goose](https://github.com/block/goose/blob/5e90925962f05acf8e255032de44d16c4a7768a2/Cargo.toml), [Pi](https://github.com/badlogic/pi-mono/blob/9841914c71a74d81abe07f751aefd271fd924e63/packages/coding-agent/package.json), [OpenCode](https://github.com/anomalyco/opencode/blob/e2894562f8ba943d72172d10b727c24d5f650c16/LICENSE). Ces licences ne dispensent pas d'inventorier les dépendances redistribuées.

Attention à Charm : **Fantasy et Crush n'ont pas la même licence**. Crush actuel est FSL-1.1-MIT, avec une restriction de « Competing Use » avant son changement futur de licence. Pour un nouveau service distribué, je n'en ferais pas une base de code à recopier sans résoudre ce point. Fantasy reste une option distincte sous Apache-2.0. [Licence Crush actuelle](https://github.com/charmbracelet/crush/blob/35a7bcab084a6022717d31b110c538a68d6fadf7/LICENSE.md).

## Go + Fantasy : le daemon sur mesure le plus direct

Fantasy fournit une API multi-provider, outils typés, génération et streaming, historique passé à chaque appel, callbacks, conditions d'arrêt et préparation entre étapes. `context.Context` est transmis aux appels et outils : c'est le point d'intégration des deadlines/annulations, dont nos outils devront effectivement respecter le signal. Ses APIs publiques inspectées ne constituent pas un gestionnaire durable de conversations prêt à héberger. [Présentation](https://github.com/charmbracelet/fantasy/blob/cb378300dd77e7b434d6806b278dc87857a15fd6/README.md), [contrat et boucle](https://github.com/charmbracelet/fantasy/blob/cb378300dd77e7b434d6806b278dc87857a15fd6/agent.go#L98).

Notre responsabilité resterait : journal de session, construction du contexte, compaction avec résumé, reprise après crash, outils de fichiers/shell, lifecycle des MCP, steering éventuel, branches et propagation parent/enfant des subagents. Le modèle produit peut rester petit : un `Run` possède son historique et son annulation ; chat, occurrence de routine et enfant sont des instances séparées. Cette réduction est une proposition, pas une fonctionnalité livrée par Fantasy.

Pour MCP, utiliser le **SDK officiel Go** plutôt que fabriquer JSON-RPC/OAuth. Sa version observée est 1.7.0 ; la documentation distingue les versions du protocole et qualifie encore certains chemins OAuth client d'expérimentaux. Tester les flux réels des providers choisis reste nécessaire. Licence : contributions nouvelles Apache-2.0, code existant MIT. [README officiel](https://github.com/modelcontextprotocol/go-sdk/blob/3f3b699b2b67e1ed033a63d6651671dab53c2d32/README.md).

Fantasy 0.43.0 déclare **Go 1.27.0** et dépend de SDK fournisseurs ; « quelques fichiers Go » ne signifie donc pas zéro dépendance. Un daemon utilisant les providers HTTP peut viser une distribution native sans Node ; l'absence de dépendances système et la compilation croisée doivent être vérifiées sur le graphe réellement importé, notamment si l'on ajoute SQLite ou de l'inférence locale. [go.mod exact](https://github.com/charmbracelet/fantasy/blob/v0.43.0/go.mod).

**Appréciation :** meilleur candidat si le binaire Go et la maîtrise du modèle d'exécution justifient de posséder explicitement persistance/compaction/outils. Pour du développement assisté par IA, garder ce contrat réduit est plus utile que laisser l'IA inventer une abstraction pour chaque provider. Cette appréciation n'est pas une mesure comparative de qualité du code généré.

## Rust + Rig : une vraie fondation d'exécution, pas seulement un wrapper LLM

La release 0.42.0 sépare désormais `rig-core`, `rig-agent` et des intégrations comme `rig-rmcp`. Elle documente un état d'exécution sérialisable sans I/O, des drivers streaming/non-streaming, outils contextuels, hooks et changement de modèle. La documentation `main` précise le protocole `AgentRun` en étapes modèle/outils/fin ; ce détail a été enrichi depuis le README du tag, donc le prototype doit épingler et vérifier l'API du tag choisi. [README 0.42.0](https://github.com/0xPlaygrounds/rig/blob/v0.42.0/crates/rig-agent/README.md), [description actuelle du protocole](https://github.com/0xPlaygrounds/rig/blob/d9ed455cf5d0c8f13207ab03c7843982a0f4898e/crates/rig-agent/README.md).

Cette séparation est intéressante pour sauvegarder entre étapes sans essayer de sérialiser une future Rust. Elle ne fournit pas à elle seule notre journal durable, la politique de reprise d'un outil ayant déjà écrit à l'extérieur, ni les contrats UI d'un subagent. Les politiques `rig-memory` inspectées couvrent notamment fenêtres de messages/tokens ; ne pas confondre cet élagage avec le cycle complet de résumé, historique intégral, reprise et branchement de Pi. [Mémoire](https://github.com/0xPlaygrounds/rig/blob/d9ed455cf5d0c8f13207ab03c7843982a0f4898e/crates/rig-memory/README.md).

L'annulation d'une tentative par abandon de la future/du stream et l'arrêt par hooks sont documentés ; la propagation aux outils externes et enfants reste un contrat à prouver. Le chantier officiel des agents interactifs rassemble justement steering, sessions durables et subagents : il faut vérifier les API livrées, et ne pas prendre une case de roadmap pour une capability disponible. [Runtime](https://github.com/0xPlaygrounds/rig/blob/v0.42.0/crates/rig-agent/README.md), [roadmap primaire](https://github.com/0xPlaygrounds/rig/issues/2118).

MCP utilise `rig-rmcp` et le SDK officiel Rust `rmcp`, disponible pour les cibles natives. Le workspace est en édition Rust 2024 et possède de nombreuses dépendances optionnelles ; construire uniquement le sous-ensemble providers distants/runtime/MCP évite d'importer vector stores et inférence locale sans besoin. [Manifest Rig](https://github.com/0xPlaygrounds/rig/blob/d9ed455cf5d0c8f13207ab03c7843982a0f4898e/Cargo.toml), [SDK MCP Rust](https://github.com/modelcontextprotocol/rust-sdk/blob/302319861a4b5ab538f6aebf25befdc3c7dfe039/README.md).

**Appréciation :** pertinent si l'on veut une machine d'exécution native explicite et quelqu'un capable de revoir les contrats async Rust. Pour une équipe qui souhaite surtout itérer par vibe coding, ownership, traits, feature flags et annulation asynchrone ajoutent une charge de revue ; la compilation ne prouve pas qu'une action externe sera exécutée une seule fois.

## Goose : Rust avec davantage déjà construit

Goose possède providers, MCP, sessions SQLite, compaction, annulation et subagents. Les sources montrent `SessionManager` avec SQLx/SQLite, `CancellationToken` dans l'agent et dans les paramètres des enfants. Il existe un fonctionnement headless documenté. Il est donc beaucoup plus proche d'un harness prêt à adopter que Fantasy. [Sessions](https://github.com/block/goose/blob/5e90925962f05acf8e255032de44d16c4a7768a2/crates/goose/src/session/session_manager.rs#L703), [agent](https://github.com/block/goose/blob/5e90925962f05acf8e255032de44d16c4a7768a2/crates/goose/src/agents/agent.rs#L219), [enfants](https://github.com/block/goose/blob/5e90925962f05acf8e255032de44d16c4a7768a2/crates/goose/src/agents/subagent_handler.rs#L36), [headless](https://github.com/block/goose/blob/5e90925962f05acf8e255032de44d16c4a7768a2/documentation/docs/tutorials/headless-goose.md).

Le CLI construit un exécutable `goose`, mais les features par défaut embarquent un produit large : code-mode, inférence locale, providers AWS, télémétrie, Nostr, keyring et mise à jour. Il existe un profil plus limité `portable-default`. La crate centrale a ses propres features et dépendances ; il faut choisir le profil, pas supposer « Rust = petit binaire autonome ». Le workspace demande Rust 1.94.1. [Manifest CLI](https://github.com/block/goose/blob/5e90925962f05acf8e255032de44d16c4a7768a2/crates/goose-cli/Cargo.toml), [crate centrale](https://github.com/block/goose/blob/5e90925962f05acf8e255032de44d16c4a7768a2/crates/goose/Cargo.toml).

**Appréciation :** candidat si le besoin devient « adopter un harness Rust déjà complet ». Moins convaincant pour « quelques primitives et notre daemon minimal » : l'extraction créerait une surface de maintenance importante. Ses subagents restent à mapper sur notre identité, historique, droits et annulation produit.

## Pi : choisir la bonne couche avant de conclure qu'il est trop gros

Les noms de packages actuels sont **`@earendil-works/*`** ; les anciennes références `@mariozechner/*` ne doivent pas être utilisées pour décrire sans vérification le nouveau projet. Le dépôt demandé `badlogic/pi-mono` sert encore les sources consultées, tandis que le manifest pointe désormais vers `earendil-works/pi`. [Manifest 0.85.0](https://github.com/badlogic/pi-mono/blob/v0.85.0/packages/coding-agent/package.json).

| Couche | Ce qu'on emprunte | Ce qu'on possède encore |
| --- | --- | --- |
| `pi-ai` | Modèles/providers, messages, streaming et outils côté protocole modèle | Boucle agent, persistance, compaction, outils locaux, MCP, enfants |
| `pi-agent-core` | Boucle, état, événements, outils, steering/follow-up, abort | Politique durable, contexte/compaction produit, outils et MCP |
| SDK `pi-coding-agent` | Session, outils coding, persistance de session, compaction et lifecycle | API daemon, identité/permissions, orchestration chat/routine/enfant, MCP produit |

Sources distinctes des couches : [pi-ai](https://github.com/badlogic/pi-mono/blob/9841914c71a74d81abe07f751aefd271fd924e63/packages/ai/README.md), [agent-core](https://github.com/badlogic/pi-mono/blob/v0.85.0/packages/agent/README.md), [SDK](https://github.com/badlogic/pi-mono/blob/9841914c71a74d81abe07f751aefd271fd924e63/packages/coding-agent/docs/sdk.md). Le core mentionne aussi un backend SQLite séparé : il ne faut pas déduire que sa classe `Agent` apporte automatiquement tout le gestionnaire de sessions du coding-agent.

Le SDK expose `createAgentSession`, événements, `prompt`, `steer`, `followUp`, `abort` et `compact`. **Steer attend une frontière d'exécution des outils ; ce n'est pas tuer immédiatement un shell.** `AgentSessionRuntime` gère le remplacement de session active (new/resume/fork/import), pas un ordonnanceur de conversations parallèles. Pour chat + routine simultanés, prévoir des instances et historiques distincts. [Contrat SDK](https://github.com/badlogic/pi-mono/blob/9841914c71a74d81abe07f751aefd271fd924e63/packages/coding-agent/docs/sdk.md#agent-session-runtime), [steering core](https://github.com/badlogic/pi-mono/blob/v0.85.0/packages/agent/README.md#steering-and-follow-up).

Pi n'intègre pas MCP dans son noyau produit : les extensions peuvent l'ajouter. L'absence de Skills Hub ne bloque pas son usage ; il faut contrôler le chargement de ressources/extensions au lieu d'activer implicitement toute la configuration découverte sur disque. [Philosophie et extensions](https://github.com/badlogic/pi-mono/blob/9841914c71a74d81abe07f751aefd271fd924e63/packages/coding-agent/README.md#philosophy), [ResourceLoader SDK](https://github.com/badlogic/pi-mono/blob/9841914c71a74d81abe07f751aefd271fd924e63/packages/coding-agent/docs/sdk.md).

**Deux distributions à ne pas confondre :**

- Le **CLI Pi officiel** possède `build:binary` avec `bun build --compile`, puis copie explicitement des assets, thèmes, docs et WASM. Cela prouve une voie de distribution du CLI, avec son profil préparé pour Bun.
- **Notre daemon qui importe le SDK et passe dans `bun --compile`** serait une nouvelle intégration. Elle n'a pas été compilée ici. Chargements dynamiques d'extensions, résolution de modules, ressources et dépendances optionnelles/natives doivent être testés. Le package npm déclare Node >=22.19.0 ; ce contrat ne certifie pas automatiquement notre embedding Bun. [Scripts, dépendances et engines](https://github.com/badlogic/pi-mono/blob/v0.85.0/packages/coding-agent/package.json).

**Appréciation :** le SDK emprunte le plus de comportement utile tout en laissant le produit à companions.build. Le risque principal devient l'adaptateur, les upgrades et le packaging. Employer uniquement `pi-ai` pour se dire « nous avons gardé Pi » transfèrerait pourtant presque tout le harness dans notre code.

## OpenCode : un exécutable et une API existante, avec un produit plus prescriptif

`opencode serve` expose HTTP/OpenAPI, sessions, enfants, interruption, résumé, prompts asynchrones et événements SSE. MCP local/distant et OAuth sont documentés ; le SDK TypeScript est un client de ce serveur. C'est une alternative sérieuse pour brancher une interface web à un moteur existant. [Serveur](https://opencode.ai/docs/server/), [SDK](https://opencode.ai/docs/sdk/), [MCP](https://opencode.ai/docs/mcp-servers/).

Son build TypeScript/Bun compile des cibles Linux/macOS/Windows, avec variantes musl/baseline et dépendances natives ciblées. La Web UI est embarquée par défaut, avec une option pour l'exclure. « Livré en binaire » ne signifie donc pas « réécrit en Go/Rust », ni « absence de runtime JavaScript ». [Build officiel](https://github.com/anomalyco/opencode/blob/e2894562f8ba943d72172d10b727c24d5f650c16/packages/opencode/script/build.ts).

**Appréciation :** choisir cette voie si le contrat public d'OpenCode convient aux usages de companions.build. Elle réduit le code de harness à produire, mais introduit son modèle de sessions/projets/permissions. Les statuts et capacités vus dans le web doivent être adaptés proprement ; éviter un fork qui taille dans ses internals à chaque release.

## Preuve à demander avant la décision

Les critères suivants sont notre proposition de validation, pas des résultats observés :

1. Même scénario pour Go/Fantasy et Pi SDK : ouvrir un chat, lancer une routine indépendante, créer un enfant avec historique propre, et suivre chacun depuis le web.
2. Interrompre pendant le stream modèle, pendant un shell et pendant un MCP ; vérifier que les processus/futures enfants se terminent et que le statut final arrive une seule fois.
3. Redémarrer entre demande modèle, résultat outil et checkpoint ; ne pas répéter une écriture externe dont l'issue est incertaine.
4. Dépasser le budget de contexte, compacter puis reprendre ; conserver résultat des outils, identité des runs et historique consultable.
5. Compiler et démarrer sur la Box cible sans toolchain de développement ; inventorier les assets et dépendances nécessaires. Les MCP stdio peuvent eux-mêmes exiger Node/Python : un daemon natif ne supprime pas ces runtimes de toute la machine.
6. Mesurer séparément démarrage, ressources au repos, émission du premier événement, premier token fournisseur et temps d'outil. Aucun des langages ne permet de promettre ces résultats sur documents seuls.

Pour du code majoritairement produit par IA, les risques déterminants sont les frontières d'effets, l'annulation et la reprise. Garder une interface de harness petite, épingler les versions et tester les comportements permet de revoir ces propriétés. Mon ordre de preuve serait **Pi SDK pour minimiser la quantité de comportement neuf**, puis **Go/Fantasy si le daemon natif et la propriété du moteur sont des objectifs explicites**. Rust/Rig devient prioritaire si l'équipe souhaite réellement posséder une machine d'exécution Rust ; Goose/OpenCode si elle souhaite adopter un harness plus complet.
