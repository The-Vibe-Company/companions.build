# companions.build — moteur d’agent et ordinateur persistant

> Recherche technique datée, à consulter pour ses sources. Les décisions produit à jour sont dans
> le [cadrage consolidé companions.build](../companions-build.md).

Recherche du 4 septembre 2026. Périmètre : nouveau produit open source, web simple, un Companion avec une Box persistante, MCP, plugins, déclencheurs et routines ; aucune intégration Skills Hub. Sources primaires consultées ce jour. Lecture du code et des contrats publics, sans benchmark ni diagnostic de production.

## Conclusion proposée

**Garder Box ; tester Pi SDK comme premier candidat et OpenCode Server comme challenger.** Pi reste un choix crédible pour un moteur embarqué que nous maîtrisons. OpenCode mérite un essai parce que son serveur et son MCP intégrés pourraient réduire notre code d’intégration. Aucun élément recueilli ne permet de déclarer l’un plus rapide ou plus fiable en production.

Les symptômes rapportés — routines qui ne partent pas, réveils manqués, systèmes qui s’arrêtent, création lente — traversent la planification, les leases, les migrations, l’image et le cycle de vie Box. **Changer Pi ne constitue pas une correction démontrée de ces problèmes.** Il faut mesurer ces couches séparément avant de choisir le moteur du nouveau produit. Cette attribution reste une hypothèse d’architecture, pas une cause racine établie.

## Point de départ vérifié dans le dépôt

- Le bundle fixe Pi `@earendil-works/pi-coding-agent@0.84.2`, `pi-mcp-adapter@2.12.1`, `pi-web-access@0.24.0`, `pi-subagents@0.51.0`, `pi-memory@0.4.2`, QMD `2.8.3` et Node 24. Le téléchargement du bundle dépend encore d’un flag ; une installation npm reste disponible. [Pins et modes](https://github.com/The-Vibe-Company/companion/blob/8d000e5a1ff3d3d068c8e67b065b78b4a9f9c2e9/packages/box-runtime/src/piBundle.ts)
- Le daemon actuel lance `pi --mode rpc --session-dir … --continue`. Le broker fait `prompt` avec `streamingBehavior: "steer"`, corrèle les réponses et conserve son propre journal. Une perte d’accusé de réception devient explicitement ambiguë. [Lancement](https://github.com/The-Vibe-Company/companion/blob/8d000e5a1ff3d3d068c8e67b065b78b4a9f9c2e9/packages/box-runtime/src/companionPiBrokerExecutable.ts), [broker](https://github.com/The-Vibe-Company/companion/blob/8d000e5a1ff3d3d068c8e67b065b78b4a9f9c2e9/packages/box-runtime/src/companionPiBrokerCore.ts)

Passer au SDK supprimerait l’encodage RPC local et une frontière de processus, **pas** le besoin d’admission durable, d’identifiants, de déduplication, d’annulation et de récupération après coupure entre notre backend et la Box. C’est une simplification à éprouver, pas une garantie de stabilité.

## Comparaison des moteurs

| Candidat | Ce qu’il fournit | Ce qui reste à notre charge / décision |
| --- | --- | --- |
| **Pi SDK** | API TypeScript directement embarquable : sessions, historique, compaction, événements, `prompt`, `steer`, `followUp`, `abort`. Choix de fournisseurs via Pi AI. | Notre daemon et son contrat durable ; adaptation MCP et permissions. Bon candidat si nous voulons un noyau extensible et peu de comportements imposés. |
| **Pi CLI RPC actuel** | Le même moteur via JSONL ; processus séparé et protocole de contrôle. | Framing, corrélation, compatibilité du protocole et journal côté broker. Utile si l’isolation du processus vaut ce coût. |
| **OpenCode Server / SDK** | Serveur headless HTTP, client TS généré, sessions, messages, arrêt, événements SSE, MCP et plugins. Nombreux fournisseurs. | Contrat produit et cycle de vie Box ; vérifier après coupure la reconstruction des événements, les doubles soumissions et les messages arrivant pendant un run. Le serveur expose aussi des concepts de développement que notre produit peut ignorer. |
| **Claude Agent SDK** | Outils fichiers/shell/web, MCP, plugins, permissions et sessions. Boucle persistante pilotable depuis un daemon. | Choix centré sur Claude ; SDK + binaire Claude embarqué. Le cycle de vie Box et les routines demeurent externes. Candidat si Claude devient une décision produit assumée. |
| **OpenAI Agents SDK** | Bibliothèque embarquable ; MCP, sessions, streaming, annulation, outils et désormais `SandboxAgent`. Fournisseurs tiers possibles via adaptateur. | Assemblage du daemon, état durable, interface utilisateur, politique d’interruption et intégration des outils. Plus pertinent qu’une simple boucle LLM artisanale, mais pas un serveur Companion prêt à l’emploi. |
| **Codex** | SDK pour automatiser des threads ; **app-server** pour clients interactifs, événements, approbations, historique, steer et interruption. | Le SDK TS wrappe encore un CLI JSONL. Pour notre chat interactif, comparer l’app-server, pas seulement `thread.run()`. Vérifier les modèles visés et ne pas présumer une compatibilité universelle. |

Pi : [SDK à la version déjà utilisée](https://github.com/earendil-works/pi/blob/v0.84.2/packages/coding-agent/docs/sdk.md), [protocole RPC](https://github.com/earendil-works/pi/blob/v0.84.2/packages/coding-agent/docs/rpc.md), [MCP par extension](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/README.md), [fournisseurs](https://github.com/earendil-works/pi).

OpenCode : [serveur](https://opencode.ai/docs/server/), [SDK](https://opencode.ai/docs/sdk/), [stockage](https://opencode.ai/docs/troubleshooting/), [fournisseurs](https://opencode.ai/docs/providers/). La documentation consultée ne promet pas un replay durable du SSE ni une admission exactement une fois après perte d’ACK : points à tester.

Son [MCP/OAuth](https://opencode.ai/docs/mcp-servers/) et ses [plugins](https://opencode.ai/docs/plugins/) ne remplacent pas l’onboarding web et l’enregistrement des webhooks de companions.build.

Claude : [hébergement](https://code.claude.com/docs/en/agent-sdk/hosting), [entrées et interruption](https://code.claude.com/docs/en/agent-sdk/streaming-vs-single-mode), [sessions disque](https://code.claude.com/docs/en/agent-sdk/sessions), [capacités](https://code.claude.com/docs/en/agent-sdk/overview).

OpenAI Agents SDK : [sandboxes](https://openai.github.io/openai-agents-js/guides/sandbox-agents/concepts/), [client Unix local utilisable dans Box](https://openai.github.io/openai-agents-js/guides/sandbox-agents/clients/), [sessions](https://openai.github.io/openai-agents-js/guides/sessions/), [modèles tiers](https://openai.github.io/openai-agents-js/guides/models/), [annulation](https://openai.github.io/openai-agents-js/guides/running-agents/), [MCP](https://openai.github.io/openai-agents-js/guides/mcp/). État conversationnel et filesystem restent distincts ; `MemorySession` disparaît au redémarrage.

Codex fournit des identifiants thread/turn et `turn/steer` cible le turn actif ; voir [app-server](https://developers.openai.com/codex/app-server) et [SDK TS/CLI](https://github.com/openai/codex/blob/main/sdk/typescript/README.md). Notre admission durable reste nécessaire.

## Box : ce que signifie « PC fixe »

**Même identité et mêmes fichiers ; pas un processus éternel ni la même machine physique.** `resume` conserve `box.id` et restaure le filesystem sur une nouvelle machine. La mémoire, les processus manuels et ports ouverts ne survivent pas ; les services systemd activés redémarrent. Les snapshots automatiques portent le disque ; ils ne remplacent donc pas notre journal de commandes. Les templates permettent de préparer le daemon et ses dépendances avant création. [Persistance et templates](https://docs.ascii.dev/box/snapshots)

Le TTL Box par défaut est une heure **depuis la création**, indépendamment de l’activité. Sur un compte payé, `ttlSeconds: null` désactive cet arrêt automatique. Les règles actuelles « une heure d’inactivité » et « garde-fou de six heures » sont donc des choix Companion, pas une limite universelle de Box. Les limites d’essai sont différentes. [Durée de vie](https://docs.ascii.dev/box/long-running-tasks)

La documentation Box décrit expressément notre modèle : backend propre, daemon privé dans la machine, service systemd et template préinstallé. Elle demande d’attendre `ready`/`idle` avant les commandes et recommande un environnement sans les credentials du compte opérateur pour les machines des utilisateurs. Création, fork et reprise consomment chacun un quota de démarrage : des routines simultanées peuvent subir cette limite. [Guide plateforme](https://docs.ascii.dev/box/platform-guide)

**Implications proposées :** un `box_id` durable par Companion ; préparation lourde hors du chemin utilisateur ; wake idempotent ; disponibilité vérifiée au niveau daemon ; expiration de credentials séparée de l’arrêt de machine. Une routine ou un webhook doit créer une demande durable côté service, même si la Box dort. Un cron uniquement dans la Box ne peut pas réveiller cette Box arrêtée.

## Licence et déploiement

Pi, OpenCode et OpenAI Agents SDK publient une licence MIT ; Codex publie Apache-2.0. Ces licences logicielles ne déterminent pas les droits d’utiliser les comptes ou abonnements des fournisseurs de modèles. [Pi](https://github.com/earendil-works/pi/blob/main/LICENSE), [OpenCode](https://github.com/anomalyco/opencode/blob/dev/LICENSE), [Agents SDK](https://github.com/openai/openai-agents-js/blob/main/LICENSE), [Codex](https://github.com/openai/codex/blob/main/LICENSE)

Claude Agent SDK relève des conditions commerciales Anthropic, sauf composants portant une licence distincte. Sa documentation interdit de proposer la connexion claude.ai ou ses limites aux clients d’un produit tiers sans accord préalable ; prévoir l’authentification API documentée. Les modalités de facturation/BYOK et d’accès aux autres fournisseurs restent à choisir et vérifier ; cette recherche n’établit pas un droit à revendre leurs abonnements. [Conditions SDK](https://code.claude.com/docs/en/agent-sdk/overview), [authentification et conformité](https://code.claude.com/docs/en/legal-and-compliance)

## Expérience minimale avant décision

Construire **un seul parcours réduit** : créer Companion → Box issue du template → message → outil MCP → réponse → arrêt → routine due → reprise → seconde réponse. Même backend, même modèle, même prompt, même région/type de Box, mêmes outils et même traitement des credentials. Aucun Skills Hub ni catalogue extensible. Précision produit ultérieure : une routine ne doit pas faire attendre le chat ; ajouter au parcours un message pendant une routine longue et vérifier sa progression indépendante. Une routine active à la fois est une limite proposée.

Une routine active à la fois, indépendante du chat, ainsi que le runtime préinstallé ont ensuite été validés par Stan. Les objectifs de démarrage restent à démontrer expérimentalement.

1. **D’abord sans LLM** : un exécuteur déterministe qui écrit un fichier et émet une réponse. Tester création/reprise, routine persistée pendant l’arrêt, redémarrage du worker, deuxième message et redémarrage du daemon. Cela isole les défaillances d’orchestration.
2. **A/B moteur** : Pi SDK contre OpenCode Server, versions figées. Ajouter Pi RPC comme témoin uniquement si le coût du transport local est suspect. Claude ou Codex n’entrent dans l’essai que si le choix fournisseur le justifie.
3. **Coupures ciblées** : après création Box mais avant sauvegarde de son ID ; après admission mais avant ACK ; après effet outil mais avant résultat ; pendant annulation ; pendant reprise. Doubler la livraison d’une routine et d’un webhook. Rejouer un événement fournisseur dans le désordre.
4. **Mesures séparées** : admission API, attente de queue, Box prête, daemon prêt, MCP prêt, premier token et fin ; p50/p95, taux d’échec, doublons d’effets, demandes perdues, RAM et coût. Distinguer démarrage frais, machine chaude et reprise avec disque existant.
5. **Promesses de sortie** : chaque demande acceptée a un résultat visible ou une interruption explicite ; aucune exécution ambiguë n’est rejouée aveuglément ; une routine due pendant le sommeil devient exécutable ; une panne d’un Companion ne bloque pas les autres ; les fichiers survivent au stop/resume ; le travail suivant progresse après panne.

Commencer par environ 30 cycles par scénario pour détecter les erreurs grossières ; augmenter ensuite le volume selon le taux d’échec que le produit veut garantir. Un petit échantillon sans panne ne démontre pas une disponibilité de production. Les objectifs de latence sont à fixer avant l’essai, pas à choisir après lecture des résultats.

Le moteur gagnant est celui qui satisfait ces promesses avec le moins de code spécifique et de modes d’échec observés. Si le témoin déterministe échoue déjà, la priorité est le contrôleur Box et la file durable, quel que soit le moteur.
