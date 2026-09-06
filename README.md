# companions.build

Nouveau projet open source de Companions avec ordinateur persistant.

- [Décisions produit et stratégie de validation](docs/companions-build.md)
- [Premier chantier de développement](docs/development-start.md)
- [Résultats de la preuve Pi/Bun sur Linux](docs/research/pi-bun-feasibility-2026-09-06.md)

Le programme expérimental utilise le vrai SDK Pi avec un modèle scripté. La
preuve Linux passe ; l'application web et le service hébergé restent à construire.

Depuis ce dossier, avec Python 3 et Docker démarré :

```sh
python3 experiments/pi-bun/verify.py
```

Cette commande prépare Bun 1.4.2 localement, installe les dépendances de build
verrouillées, compile et exécute les tests dans Linux x86_64. Le conteneur testé
n'a ni réseau extérieur, ni Node, ni Bun installé, ni gestionnaire de paquets.
La préparation initiale télécharge les outils et l'image ; les exécutions du
programme n'installent rien. Aucun compte modèle ou Box n'est requis.

Les traces, fichiers, mesures, sommes SHA-256 et l'archive de distribution restent
dans `.artifacts/pi-bun/<run>/`. `.artifacts/pi-bun/latest.json` indique le dernier
résultat. Pour reproduire un scénario :

```sh
python3 experiments/pi-bun/verify.py --scenario 'crash after'
```

Chaque exécution a ses répertoires et ses conteneurs nommés. La vérification
verrouille uniquement son dossier de travail ; des worktrees distincts peuvent
être vérifiés en parallèle. Le code sous `experiments/` sert à vérifier les
choix techniques et ne constitue pas le futur protocole de production.
