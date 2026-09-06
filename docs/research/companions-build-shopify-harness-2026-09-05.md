# companions.build — que désigne le « harness Shopify » ?

Recherche du 5 septembre 2026, sources officielles uniquement. Aucun benchmark exécuté. Le nom évoqué n’étant pas connu, l’identification reste ouverte entre trois objets distincts.

## Réponse courte

**Shopify apporte surtout une référence d’architecture, pas un moteur Go prêt à installer identifié dans cette recherche.** River/Aquifer est la référence la plus pertinente pour les sessions persistantes. Roast est le candidat réellement public à examiner comme dépendance, mais il orchestre déjà Pi ou Claude : l’adopter ajouterait Ruby et une couche de workflows à companions.build.

| Nom | Nature vérifiée | Disponibilité pertinente |
| --- | --- | --- |
| **River / Aquifer** | Agent Slack et plateforme interne d’exécution. | Article d’architecture ; aucune distribution publique réutilisable identifiée. |
| **Dispatch** | Orchestrateur interne Ruby pour scans AppSec et validation par tests. | Présentation technique ; aucun SDK public identifié. |
| **Roast** | DSL Ruby de workflows, publié par Shopify. | Sources et gem `roast-ai`, licence MIT. |

Sources : [River/Aquifer](https://shopify.engineering/under-the-river), [Dispatch](https://shopify.engineering/building-an-agentic-harness-that-outlasts-the-model), [Roast](https://github.com/Shopify/roast).

## River/Aquifer : Go et Pi ne s’excluent pas

L’article du 28 mai 2026 sépare session durable, boucle d’agent et sandbox. L’historique canonique est un journal append-only PostgreSQL. La boucle vit **hors de la sandbox** et ses processus sont remplaçables. Les cellules de session exécutent un runtime Go et le harness dans le même groupe de processus ; elles disparaissent à l’inactivité. Les profils sont des bundles Nix : prompt, skills, extensions, politique sandbox et modèles. Le profil **Vanilla utilise Pi headless**.

Cela ne prouve ni que toute la boucle soit écrite en Go, ni qu’un unique binaire statique soit distribué. L’article ne spécifie pas le contrat MCP, la compaction, les approbations interactives ou l’annulation. Aucune licence de code réutilisable n’y est fournie. [Source : Under the River](https://shopify.engineering/under-the-river)

**Application proposée à notre projet :** conserver l’identité de la conversation indépendamment du daemon et de la machine. La Box persistante peut être le lieu d’exécution des outils, même si le moteur est ailleurs. Ce placement change le transport des outils et des fichiers : c’est une décision séparée du choix Go/TypeScript et Pi/OpenCode. Copier l’ensemble de la plateforme Shopify serait disproportionné pour une première application web simple.

## Dispatch : un workflow spécialisé

L’article du 29 juillet 2026 décrit un client Ruby mince, un backend Rails et une chaîne de chasse aux vulnérabilités, validation par tests et production de correctifs. Il met en avant la vérification avec un autre modèle et le traitement déterministe des credentials, de Git et du stockage. Son API de moteur, sa distribution, MCP et sa politique de session interactive ne sont pas documentés comme composants réutilisables. [Présentation officielle](https://shopify.engineering/building-an-agentic-harness-that-outlasts-the-model)

**À retenir :** définir les critères de réussite et les transitions dans notre code. La publication du 2 septembre montre River vérifiant les systèmes réels avant d’agir et après fusion, plutôt que de confondre un résultat annoncé avec un résultat acquis. Cette leçon s’applique à « routine réellement lancée » et « Box réellement disponible ». Elle ne démontre pas la fiabilité d’une dépendance que nous pourrions installer. [Remédiation avec River](https://shopify.engineering/river-vulnerability-remediation)

## Roast : vérification du code actuel

Sources inspectées au commit **`0cd5406ea02ac8f64b8b7a697270fd4d84a57b2c`**, daté du 10 août 2026. L’[article d’introduction de juin 2025](https://shopify.engineering/introducing-roast) parlait de YAML ; le README actuel décrit un DSL Ruby. Les résultats web en cache divergent aussi sur le fournisseur par défaut : le code du commit inspecté tranche.

| Dimension | Constat dans cette version |
| --- | --- |
| Langage et distribution | Gem Ruby `roast-ai`, bibliothèque et exécutable. La gemspec exige Ruby ≥ 3.3, malgré « Ruby 3.0+ » dans le README. Dépend notamment d’Async, ActiveSupport et RubyLLM ; ce n’est pas une distribution Go/Rust autonome. |
| Fournisseurs | Le cog `chat` déclare OpenAI, Anthropic, Perplexity et Gemini. Le cog `agent` lance **Pi par défaut**, ou Claude ; le CLI choisi doit déjà être installé et authentifié. Ce sont deux niveaux de fournisseurs différents. |
| MCP | L’agent accède aux MCP configurés dans le CLI délégué. Je n’ai pas identifié de client MCP générique ni de gestion OAuth propre à Roast dans le code `lib/` inspecté. |
| Sessions | Claude utilise `--resume`, avec fork selon le contexte. L’invocation Pi utilise `--fork <session>` si une session est fournie, sinon `--no-session`. Les identifiants sont remontés au workflow. Cela ne fournit pas notre contrat de thread durable avec admission dédupliquée. |
| Compaction | La session `chat` sait tronquer les premiers/derniers messages. Le parseur Claude reconnaît des métadonnées de compaction ; aucune stratégie de compaction propriétaire complète n’a été identifiée. La compaction de l’agent reste affaire du moteur délégué. |
| Permissions | La configuration active les permissions par défaut. L’adaptateur Claude traduit leur désactivation en `--dangerously-skip-permissions`. L’adaptateur Pi inspecté ne lit pas ce réglage : ce n’est pas une politique uniforme entre moteurs. |
| Interruption | Les invocations sont des sous-processus : Pi en `--mode json -p`, Claude en mode print/stream-json. `CommandRunner` ferme stdin après le prompt ; il propose timeout et nettoyage par signaux. Aucune API publique steer/annulation d’un turn actif comparable à Pi SDK n’a été identifiée. Les appels agent inspectés ne transmettent pas de timeout à ce runner. |
| Licence | MIT pour Roast. Les droits et contraintes des CLIs et fournisseurs restent séparés. |

Preuves précises : [gemspec](https://github.com/Shopify/roast/blob/0cd5406ea02ac8f64b8b7a697270fd4d84a57b2c/roast-ai.gemspec), [README](https://github.com/Shopify/roast/blob/0cd5406ea02ac8f64b8b7a697270fd4d84a57b2c/README.md), [configuration agent](https://github.com/Shopify/roast/blob/0cd5406ea02ac8f64b8b7a697270fd4d84a57b2c/lib/roast/cogs/agent/config.rb), [configuration chat](https://github.com/Shopify/roast/blob/0cd5406ea02ac8f64b8b7a697270fd4d84a57b2c/lib/roast/cogs/chat/config.rb), [cog agent/MCP](https://github.com/Shopify/roast/blob/0cd5406ea02ac8f64b8b7a697270fd4d84a57b2c/lib/roast/cogs/agent.rb), [invocation Pi](https://github.com/Shopify/roast/blob/0cd5406ea02ac8f64b8b7a697270fd4d84a57b2c/lib/roast/cogs/agent/providers/pi/pi_invocation.rb), [invocation Claude](https://github.com/Shopify/roast/blob/0cd5406ea02ac8f64b8b7a697270fd4d84a57b2c/lib/roast/cogs/agent/providers/claude/claude_invocation.rb), [session chat](https://github.com/Shopify/roast/blob/0cd5406ea02ac8f64b8b7a697270fd4d84a57b2c/lib/roast/cogs/chat/session.rb), [métadonnées Claude](https://github.com/Shopify/roast/blob/0cd5406ea02ac8f64b8b7a697270fd4d84a57b2c/lib/roast/cogs/agent/providers/claude/messages/system_message.rb), [runner de processus](https://github.com/Shopify/roast/blob/0cd5406ea02ac8f64b8b7a697270fd4d84a57b2c/lib/roast/command_runner.rb), [licence](https://github.com/Shopify/roast/blob/0cd5406ea02ac8f64b8b7a697270fd4d84a57b2c/LICENSE.md).

## Décision proposée pour companions.build

**Ne pas ajouter Roast au noyau initial.** Il convient à des workflows explicites mélangeant commandes, Ruby et appels d’agents. Notre produit demande d’abord un thread, un ordinateur, un envoi et une reprise fiables. Faire tourner Roast headless dans Box paraît techniquement possible en préinstallant Ruby, la gem et le CLI, mais n’enlève ni ce CLI, ni notre daemon, ni notre ordonnanceur.

**Ne pas justifier une réécriture complète du moteur par « Shopify le fait en Go ».** La source montre que Go peut gérer le runtime alors que Pi reste un profil supporté. Un petit daemon Go/Rust et un moteur existant sont donc des choix compatibles. À l’inverse, si l’objectif est strictement un seul binaire qui contient aussi la boucle LLM, il faut évaluer ce produit exact ; River/Aquifer n’en fournit pas la preuve publique.

L’enseignement applicable reste limité et concret : état durable externe aux processus, transitions explicites, outils exécutés dans une frontière claire, préparation reproductible et preuve du résultat. Le choix d’un moteur maison se tranche ensuite sur un prototype mesurant démarrage, annulation, reprise et MCP, pas sur la ressemblance avec l’architecture d’une grande entreprise.

Limites : l’identité du projet Shopify évoqué n’est pas confirmée ; « aucun composant identifié » n’est pas une preuve d’absence absolue. Les comportements Roast sont issus de lecture de code, pas d’un test en Box. Aucun résultat de performance de Shopify n’est extrapolé à companions.build.
