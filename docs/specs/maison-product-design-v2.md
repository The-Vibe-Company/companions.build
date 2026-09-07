# Maison V2 — design produit et création d’équipe

Plan du 7 septembre 2026. Première implémentation livrée : navigation directe, équipe de spécialistes et création guidée. Voir [validation](../measurements/maison-v2-2026-09-07.md).

Proposition initiale : Audit du front à partir du commit 70a5e80 et des
captures desktop/mobile de la passe précédente. Ce document définit la prochaine passe ;
les paragraphes de proposition conservent aussi les pistes futures ; le rapport de validation distingue ce qui est livré. Il remplace les recommandations
UI du plan maison-interface-control-mcp.md. Le MCP existant reste conservé.

## Intention

Une personne doit comprendre à qui parler, ce qui se fera automatiquement et qui peut aider
son companion. Le produit reste une application personnelle, claire, chaleureuse, utilisable
sans connaître MCP, template ou replica. Le chat est le point de départ quotidien.

Direction confirmée : thème clair uniquement, très peu d’information, couleur dans les
formes et visages des companions. On améliore Maison, sans repartir vers une nouvelle esthétique.

## Critique de la première passe

| Priorité | Constat et preuve | Conséquence | Correction proposée |
| --- | --- | --- | --- |
| P1 | SettingsSheet : réglages → Automatisations → Routines, ou réglages → Équipe et partage → Spécialistes. | Trois actions depuis le chat pour atteindre des fonctions centrales. | Discussion, Automatisations et Équipe visibles au même niveau. |
| P1 | SpecialistsSettings affiche instances, lancement manuel, versions et création de profil dans la même vue. | On ne comprend pas la différence entre constituer une équipe et lui donner du travail. | Vue des spécialistes autorisés ; ajouter/configurer un spécialiste séparément de lancer une tâche. |
| P1 | Le handler spawn accorde une permission puis lance une instance ; aucune composition d’équipe indépendante dans ce formulaire. | L’utilisateur ne peut pas simplement préparer les capacités du coordinateur par ce parcours. | Action explicite Ajouter à l’équipe, persistée sans lancement. |
| P2 | Équipe et partage mène aussi à la livraison client. | « Équipe » peut désigner agents, collaborateurs humains ou clients. | Équipe = agents qui aident ce companion ; livraison dans un parcours distinct. |
| P2 | CreateCompanion expose AvatarPicker complet, mission et choix d’ordinateur dès le départ. | Beaucoup de décisions avant de comprendre la valeur du produit. | Nom et rôle d’abord ; apparence via aperçu cliquable ; choix techniques avancés. |
| P2 | Connexions utilise des initiales de fournisseur et répète Check/Disconnect par ligne. | Reconnaissance lente, actions administratives trop présentes. | Marques officielles locales, état lisible, menu secondaire pour vérifier/déconnecter. |
| P2 | L’accueil affiche un slogan et les instructions des companions ; la sidebar répète Ready/Sleeping. | Du texte peu utile occupe l’espace de travail. | Accueil orienté reprise ; noms/rôles courts ; signaler surtout les états qui demandent de l’attention. |
| P2 | Maison superpose ses sélecteurs au grand index.css, dont plusieurs tailles et composants restent différents. | Les finitions varient selon les écrans et les correctifs s’empilent. | Consolider progressivement les tokens et composants réellement partagés. |

Ces constats concernent le code et les captures inspectés, pas une étude utilisateur.
Le premier test d’usage devra vérifier la découverte des fonctions et le vocabulaire d’équipe.

## Modèle simple proposé

- **Companion** : un interlocuteur permanent, avec son nom, son visage et sa conversation.
- **Équipe de ce companion** : les spécialistes qu’il est autorisé à mobiliser.
- **Spécialiste** : une compétence réutilisable, configurée avant d’être appelée pour une tâche.
- **Intervention** : le travail concret d’un spécialiste. Il se termine ; son résultat reste consultable.

« Équipe » est ici une présentation des relations du coordinateur, pas un nouveau projet ni
un chat de groupe. Chaque companion garde sa conversation. Une équipe peut être nommée par le
nom du coordinateur ; aucun champ de nom supplémentaire n’est requis.

Les companions permanents peuvent aussi recevoir des délégations. Leur ajout au parcours équipe
nécessite de vérifier les droits et relations réellement disponibles côté serveur. Ne jamais
présenter un profil réutilisable comme un interlocuteur permanent, ni une simple sélection
visuelle comme une permission enregistrée.

## Navigation

Sidebar : marque discrète, liste des companions, bouton +, menu compte en bas.
Le bouton + propose Créer un companion ou Créer une équipe. Il s’agit de deux entrées du même
parcours, pas de deux modèles incompatibles.

Dans le companion, une petite navigation textuelle :

| Accès visible | Contenu | Action principale |
| --- | --- | --- |
| Discussion | Conversation, fichiers, demandes d’aide ; activité contextuelle | Envoyer |
| Automatisations | Deux vues Routines / Événements ; listes avec états persistés | Ajouter une routine ou un événement selon la vue |
| Équipe | Coordinateur et liste des spécialistes autorisés | Ajouter un spécialiste |

Le nom/visage du companion ouvre sa fiche. Un menu nommé Réglages donne directement accès à
Personnalité, Applications, Ordinateur et Livraison client. Aucun passage par une page intermédiaire
sans information utile. L’historique complet du travail reste accessible même sans tâche active.
Les connexions globales et l’abonnement restent dans le menu compte.

Automatisations et Équipe sont des vues dans le contenu principal, pas des formulaires enfermés
dans une succession de panneaux latéraux. Une édition courte peut employer un panneau unique.
Sur mobile : mêmes trois accès textuels ; détail plein écran et retour explicite.
URLs restaurables et Retour navigateur cohérent ; préserver le brouillon et la position du chat.

## Création d’une équipe

Objectif : préparer une équipe sans obliger l’utilisateur à lancer une tâche de démonstration.

1. **Choisir le coordinateur.** Utiliser un companion existant ou en créer un avec nom et rôle.
   Exemple de rôle : « M’aider à développer et maintenir mon application ». Aperçu du visage
   déjà proposé ; cliquer dessus personnalise. L’apparence n’est pas une étape obligatoire.
2. **Ajouter des spécialistes.** Choisir un profil existant ou définir nom et compétence.
   Montrer une ligne par spécialiste avec visage, nom et rôle ; édition et retrait accessibles.
   Les exemples de rôles ne prétendent pas installer des logiciels ou connecter des applications.
3. **Vérifier et créer.** Résumé court : coordinateur, spécialistes et accès nécessaires.
   Action Créer l’équipe. Au succès, ouvrir la Discussion avec la composition consultable dans Équipe.
   Si aucun spécialiste n’est ajouté, conserver la possibilité de créer simplement le companion.

Créer/configurer ne lance pas d’intervention. Les accès aux applications restent explicites,
avec réutilisation des connexions consenties ; aucune transmission silencieuse de comptes.
Le nombre de copies simultanées reste un réglage avancé de spécialiste, sans dominer ce parcours.

La création multi-étapes doit être reprenable et idempotente : une reprise après erreur ne doit
pas dupliquer le coordinateur ou les profils. Conserver les éléments déjà créés, montrer ce qui
reste à enregistrer et proposer Réessayer. Ne pas annoncer Équipe créée après une réussite partielle.
Cette garantie est à implémenter/vérifier, pas à simuler avec un état local optimiste.

## Utiliser l’équipe

La page Équipe montre d’abord « Qui peut aider [nom] ? » et les spécialistes disponibles.
Les interventions en cours sont une section distincte, affichée seulement lorsqu’elles existent.
Elles exposent tâche, état réel et accès au résultat ; aucune animation permanente des visages.

L’utilisateur peut demander le travail dans le chat. Une action secondaire Confier une tâche
sur un spécialiste ouvre une saisie courte. Constituer l’équipe ne doit pas imposer ce lancement.
Les enfants terminés quittent la liste du travail en cours mais restent dans l’historique.

Les changements d’un enfant peuvent faire l’objet d’une proposition Mettre à jour le spécialiste.
Expliquer que l’adoption de sa machine affecte les prochains lancements et que les identifiants
personnels ne deviennent pas des éléments partageables. Cette interface doit se baser sur le
contrat d’adoption et ses états existants ; pas de nouveau mécanisme de snapshot dans cette passe.
Versions et restauration restent dans le détail avancé du spécialiste.

## Direction visuelle

La scène : une personne ouvre ses companions sur son ordinateur ou son téléphone en journée,
pour déléguer quelque chose rapidement. Le blanc chaud domine, le texte est net, les visages
permettent de reconnaître les interlocuteurs avant de lire leurs noms.

- Trois surfaces neutres : fond blanc chaud, navigation légèrement teintée, surface de saisie blanche.
- Une famille sans serif ; corps 15–16 px, labels 14 px, titres d’écran 24–28 px, chat 16 px.
  Limiter les graisses à quatre niveaux et éviter les petits textes peu contrastés.
- Avatars 36 px dans la navigation, 44–48 px dans l’équipe, 80 px pour personnaliser.
  Conserver les formes et identifiants existants ; affiner les yeux et leur lisibilité à petite taille.
- Palette des personnages resserrée visuellement : corail, jaune doux, pervenche, vert sauge.
  Les anciennes couleurs personnalisées restent disponibles et conservées.
- Une composition forte pour l’équipe : coordinateur identifié, puis spécialistes en liste.
  Pas d’organigramme interactif, de graphe ni de grille de grandes cartes pour quatre personnes.
- Icônes discrètes et boutons secondaires cohérents ; une action principale par vue.
  Les menus supplémentaires ont un nom accessible et fonctionnent au clavier et au tactile.
- Surfaces mates ; pas de texture papier, dégradé, halo ou effet vitre.
- Transitions brèves de 160–200 ms pour ouvrir ou changer de vue ; aucune attente décorative.
- Marques de fournisseurs en assets SVG locaux fiables ; pas d’images distantes chargées à chaque vue.

Le chat reste calme : une courte invitation au premier message, puis uniquement la conversation.
Le compositeur démarre compact et grandit avec le texte ; les résultats sont lisibles sans afficher
par défaut chaque détail d’exécution. Une erreur ou une question ne doit jamais être masquée.

## États et garanties à dessiner

Vide, chargement, erreur de lecture, sauvegarde en cours, échec conservant la saisie, indisponibilité
d’une connexion, autorisation retirée, équipe partiellement créée, intervention terminée et question
sans réponse. Distinguer autorisé, en cours et terminé ; le statut d’un profil n’est pas celui d’une Box.
Une automatisation enregistrée n’est pas une automatisation déjà exécutée.

Toute valeur visible vient de l’état persisté ou d’un brouillon explicitement en édition. Le thème
reste clair avec un OS sombre. Cibles tactiles 44 px, contraste AA, mouvement réduit, zoom 200 %,
noms longs et largeurs 390/768/1440 px font partie de la validation.

## Ordre de réalisation

1. **Accès aux fonctions.** Remplacer la navigation de réglages imbriquée par Discussion /
   Automatisations / Équipe. Valider URL, retour, brouillon et focus.
2. **Écran Équipe de référence.** Séparer profils autorisés, édition et interventions ; vérifier
   les capacités serveur de lecture, ajout et retrait des permissions avant d’afficher les actions.
3. **Création guidée.** Réutiliser les API existantes de companion/profil/permission, ajouter les
   garanties de reprise manquantes. Aucune nouvelle entité équipe ni instance lancée par défaut.
4. **Finitions cohérentes.** Personnalisation progressive, connexion des apps, marques fournisseurs,
   typographie, compositeur et consolidation des styles. Livraison client hors de la page Équipe.
5. **Validation.** Tests de comportements ciblés et parcours navigateur sur les trois largeurs.
   Si API/permissions touchées : couverture droits, répétition et échecs partiels. Garder les suites
   de stabilité existantes, sans nouveaux jobs CI ni Box réveillée pour une simple inspection UI.

## Critères de réussite

- Depuis le chat, Équipe en une action ; Routines et Événements en deux au maximum.
- Une personne peut expliquer qui est son interlocuteur et qui intervient ponctuellement.
- Ajouter un spécialiste à l’équipe ne lui confie pas une tâche et ne démarre pas une machine.
- Créer l’équipe ne demande ni choix de harness, ni MCP, ni version, ni console fournisseur.
- Aucun succès annoncé après sauvegarde partielle ; reprise sans duplication.
- Les mêmes fonctions restent accessibles sur mobile, sans action essentielle réservée au survol.
- Dans le premier test d’usage, demander « ajoute un spécialiste puis configure un point chaque
  lundi » sans donner le chemin. Observer les hésitations avant de qualifier l’interface d’intuitive.

## Limites du plan

La proposition est un design et un découpage de réalisation. Les parcours équipe, URLs des
rubriques et protections supplémentaires restent à construire. On conserve Better Auth,
PostgreSQL, shadcn, AI Elements, Pi/Bun, Box et companion-control. Les autorisations entre
companions permanents doivent être vérifiées avant de généraliser le modèle d’équipe au-delà
des spécialistes du coordinateur.
