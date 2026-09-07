# Feature Spec: Maison — interface et MCP de contrôle

> Mise à jour du périmètre, 7 septembre 2026 : l'utilisateur conserve le MCP
> `companion-control` existant et demande de poursuivre uniquement la refonte UI/UX.
> Thème **clair exclusivement**, sans mode sombre ni préférence système. Les propositions
> de parité MCP et d'autosave ci-dessous restent des pistes, hors de cette passe.
> L'identité garde une sauvegarde explicite ; aucune API ni garantie runtime ne change.


## Summary

Refondre companions.build autour d'une interface personnelle, chaleureuse et très sobre :
les companions apportent la couleur et la personnalité, le chat reste le centre du produit,
les réglages se découvrent progressivement. Compléter le MCP `companion-control` existant
pour que les companions puissent consulter et modifier leur configuration avec les mêmes
règles que le web.

Statut : plan proposé le 7 septembre 2026, prêt pour réalisation après arbitrage éventuel.
La demande porte ici sur la planification ; aucun changement applicatif n'est livré par cette spec.
Direction retenue pour le plan : dernière maquette « Maison », affinée par la demande de menus légers.
La maquette illustre le style ; ses données et confirmations ne sont pas des fonctionnalités validées.

## Problem

Le front concentre navigation, chat et plusieurs formulaires dans `App.tsx`. Les réglages proposent
six onglets au même niveau, avec des actions et des formulaires visibles trop tôt. Le produit
possède davantage de capacités que sa navigation ne l'explique simplement.

Le MCP existe déjà : routines, triggers, identité, plugins, délégation et templates sont exposés.
Son outil générique reçoit une opération et un objet libre ; les exemples et opérations disponibles
sont en partie maintenus séparément. La parité web/agent, la découverte des paramètres et le retour
visible d'une modification doivent devenir explicites et testables.

## Goals

- Comprendre immédiatement à qui parler et comment envoyer une demande.
- Accéder à une rubrique de réglages depuis le chat en deux actions maximum.
- Une action principale par vue ; les actions secondaires restent accessibles au clavier et au tactile.
- Reconnaître chaque companion par sa silhouette, sa couleur et son visage.
- Configurer une routine ou un trigger aussi bien dans le chat que dans les réglages.
- Voir dans le web les modifications réellement persistées par l'agent, sans recharger la page.
- Préserver les garanties de concurrence, de reprise et de séparation du chat et du travail de fond.

## Non-Goals

- Nouveau harness, nouveau moteur de routines, refonte Box ou travail VNC.
- Nouveau Skills Hub ou marketplace ; les skills Pi existants restent disponibles.
- Serveur MCP public universel ou autorisation implicite pour des clients externes.
- Dashboard de métriques, écran d'administration supplémentaire ou multiplication de thèmes.
- Migration destructive des companions, historiques, configurations ou secrets.

## Users And Use Cases

L'utilisateur principal crée quelques companions et leur confie du travail sans administrer une
infrastructure. Il peut aussi préparer un companion pour un client ; cette capacité reste accessible
mais ne domine pas l'accueil.

Exemples : « Fais mon point chaque matin à 9 h », « Surveille les échecs de CI sur main »,
« Mets cette routine en pause », « Change ton nom et ton visage », « Utilise mon compte GitHub »,
« Délègue cette recherche au spécialiste autorisé ».

## Proposed Behavior

### Navigation principale

- Sidebar : marque discrète, création « + », liste des companions, menu compte en bas.
- Le menu compte regroupe Connexions et Abonnement.
- Les invitations/livraisons et accès de maintenance restent dans Compte, visibles quand pertinents.
- Dans un chat : identité cliquable ouvrant les réglages, indicateur d'activité si travail actif
  ou question en attente, champ de saisie. Pas de barre de boutons pour toutes les fonctionnalités.
- L'historique d'activité reste accessible depuis les réglages même sans tâche active.
- Sur mobile : liste puis chat ; réglages en vue pleine hauteur avec retour clair, un seul niveau
  de navigation affiché à la fois. Aucun empilement de modales.
- Les vues et rubriques ont une URL restaurable ; Retour navigateur revient à la vue précédente.
  Les anciennes URLs `/companions/:id` restent valides.

### Chat et première utilisation

- L'accueil expressif et les trois suggestions apparaissent seulement dans une conversation vide.
- Une suggestion prépare un message éditable ; elle ne lance aucun travail avant l'envoi.
- Dès qu'il y a des messages, le titre d'accueil et les suggestions disparaissent.
- Pièces jointes regroupées dans le « + » du compositeur ; un seul bouton Envoyer/Arrêter selon état.
- Résultats et questions en attente restent visibles, y compris dans les tâches de fond.
- Une modification de configuration peut produire un petit reçu issu de la commande persistée :
  « Routine créée · Tous les jours, 9 h », avec un lien vers sa configuration. Ce reçu ne signifie
  pas que la routine a déjà exécuté son travail ni qu'un webhook distant est enregistré.
- Garder la position de lecture et le brouillon lors de l'ouverture des réglages et des reconnexions.

### Réglages du companion

Vue d'entrée courte avec résumé, puis rubriques :

1. **Personnalité** : nom, forme, visage, couleur, mission ; modèle dans les options avancées.
2. **Applications** : accès de ce companion aux connexions existantes ; ajouter une connexion sans
   obliger l'utilisateur à rechercher la page globale.
3. **Automatisations** : deux groupes Routines et Déclencheurs ; compte et état, pas de formulaire
   de création ouvert par défaut.
4. **Équipe et partage** : spécialistes, templates et livraison client, révélés dans cette rubrique.

Routines : nom, horaire lisible, prochain passage et activation ; une action Ajouter. Sélectionner
une ligne ouvre son édition et son historique. Tester reste une action secondaire explicite.
Déclencheurs : source, événement et état de connexion ; mode direct par défaut. Le filtre de code,
les lectures API, le payload de test et les détails techniques sont dans une section avancée.

Sauvegarde : nom/apparence et bascules simples s'enregistrent automatiquement après validation,
avec « Enregistrement… », confirmation discrète et erreur persistante si nécessaire. La mission,
un filtre de code et un formulaire de création se valident explicitement. Ne jamais autosauvegarder
un code incomplet ou annoncer un succès avant la réponse serveur. Fermer une édition invalide ou
en échec conserve son brouillon. Une modification concurrente web/agent ne doit pas écraser
silencieusement une valeur plus récente.

### Identité visuelle et finitions

- Blanc légèrement chaud, surfaces neutres, encre charbon ; thème clair uniquement.
- Couleurs franches réservées surtout aux personnages ; couleurs de statut distinctes de l'identité.
- Typographie sans serif unique, corps 14–16 px, titres contenus, interlignage confortable.
- Avatars de navigation 32–40 px ; grand avatar réservé à la personnalisation et à l'accueil vide.
- Espacement cohérent sur base 4 px, rayons 8–12 px, séparateurs fins uniquement utiles.
- Pas de texture papier, halo, glassmorphism, dégradé décoratif ou carte autour de chaque paragraphe.
- Transitions brèves de 150–200 ms ; pas d'animation permanente des visages. Respect du mouvement réduit.
- Focus visible, cibles tactiles de 44 px, contrastes AA, textes longs et zoom 200 % pris en compte.
- Les états de chargement, vide, refus, erreur, hors ligne et lecture seule font partie du design.

## UX / API / System Details

### MCP : conserver et compléter l'existant

`packages/control/agent.ts` installe déjà un serveur MCP dans Pi, nommé `companion-control`,
avec l'outil `companion_control`. Ses commandes sont journalisées localement puis traitées par
le control plane. Conserver ce transport et les identifiants d'opérations existants.

| Capacité | Existant vérifié dans le code | Travail prévu |
| --- | --- | --- |
| Identité et modèle | `identity`, `models`, `configure` | Paramètres typés découvrables, résultats homogènes, édition concurrente protégée |
| Routines | liste, save, delete, test, history | Parité explicite web/MCP, reçu lié à l'entité et horaires lisibles |
| Triggers | liste, save, delete, test, history ; registration via `trigger_save` | Exposer clairement création, filtre et retry d'enregistrement ; état distant distinct du succès local |
| Applications | catalog, connect, custom, select, check, disconnect | Même état de connexion côté web/chat, lien de consentement visible et résultat vérifié |
| Tâches | status, answer, cancel, ask_user | Accès au détail depuis le chat, ciblage explicite des tâches autorisées |
| Équipe et templates | delegate, spawn, permission, save, history, rollback, adopt | Rendre accessibles les capacités existantes sans alourdir la navigation |
| Livraison / maintenance | prepare, list, inspection et opérations sous mandat | Afficher les étapes et limites du mandat, garder les consentements client |
| Skills Pi | liste/install/update/remove locaux | Préserver le chemin existant ; aucun nouveau système de skills |
| Apparence du site / compte | Pas de contrôle MCP équivalent identifié | Préférence humaine du site, pas une modification autonome par chaque companion |
| Abonnement / consentements | Flux humains existants | Préparer une action ou un lien autorisé ; pas de paiement ni consentement automatique |

Créer un catalogue partagé léger des capacités : nom, description, schéma d'entrée, périmètre,
forme de résultat et état asynchrone. Les instructions Pi et la découverte MCP s'appuient dessus.
Ne pas envoyer une longue documentation de toutes les opérations à chaque tour : découverte
courte puis description détaillée de la famille demandée. Préserver la compatibilité du tool existant.

L'API web et les handlers MCP appellent les mêmes services métier. Ne pas créer un interpréteur
HTTP générique donnant accès à toutes les routes. Une capacité indisponible est annoncée comme telle.
Les résultats distinguent modification appliquée, demande persistée, action humaine requise et
échec ; les identifiants d'entités permettent à l'interface d'ouvrir le bon détail.

Pour une commande rejouée, l'identifiant durable et l'empreinte de l'opération/entrée doivent
correspondre. Une entrée différente sous le même identifiant est un conflit, pas un ancien succès.
Une issue inconnue conduit à consulter l'état, jamais à rejouer aveuglément un effet externe.

## Data And State

- PostgreSQL reste la source des profils, automatisations, tâches et états de connexion.
- Réutiliser les journaux de commandes existants pour la traçabilité ; ajouter seulement les
  références nécessaires aux reçus UI. Aucun événement de succès synthétique.
- Auditer l'invalidation des vues de configuration : une modification agent d'une routine,
  d'un trigger ou d'un accès doit rafraîchir la rubrique ouverte. Étendre les événements existants
  si nécessaire ; ne pas ajouter un second mécanisme global de polling.
- Utiliser une révision attendue sur les configurations éditables simultanément. Retour de conflit
  visible, brouillon conservé, nouvelle valeur consultable. Migrations additives et compatibles.
- Thème clair fixe, y compris lorsque le système est en mode sombre.
- Ne pas écrire de secrets dans les URLs, événements de configuration, reçus ou stockage navigateur.

## Permissions And Trust Boundaries

Le MCP agit avec l'identité du companion et de sa tâche, sous les droits du propriétaire. Il ne
choisit pas un autre propriétaire dans ses paramètres. Un enfant conserve ses restrictions et ne
peut pas s'accorder de nouveaux droits. Les accès de maintenance restent ceux du mandat existant.

Les réglages ordinaires autorisés s'appliquent directement. Un companion peut initier OAuth et
présenter le lien, mais seul l'humain donne le consentement. Les paiements et la prise de contrôle
humaine du bureau restent humains. Les modifications de configuration ne deviennent pas une
permission générale d'envoyer des messages externes, de facturer ou de partager un compte connecté.

## Edge Cases

- Reconnexion pendant une sauvegarde : relire l'état ; conserver le brouillon et l'identité de requête.
- Retour tardif d'une sauvegarde après sélection d'un autre companion : ne pas modifier la nouvelle vue.
- Web et agent éditent simultanément : conflit explicite, sans écrasement silencieux.
- Routine supprimée ou companion retiré : afficher l'état terminal et interdire une nouvelle admission.
- Trigger enregistré localement mais OAuth manquant : « Connexion nécessaire », jamais « Actif » inféré.
- Aucun modèle/compte compatible : expliquer ce qui manque à proximité de l'action.
- Longues missions, noms et résultats : retour à la ligne, sections scrollables, actions accessibles.
- Tâche en attente humaine : question accessible même si une autre tâche tourne.
- Échec d'autosave puis fermeture : conserver les données saisies et proposer une reprise claire.

## Acceptance Criteria

- [ ] Sidebar limitée aux companions, création et menu compte ; aucune fonctionnalité existante perdue.
- [ ] Chaque rubrique de réglages est accessible en deux actions depuis le chat.
- [ ] Chat non vide sans grand titre d'accueil ni suggestions persistantes.
- [ ] Profil, applications, routines et triggers utilisables à 390 px sans scroll horizontal.
- [ ] Réglages navigables au clavier, retour navigateur correct, focus rendu au déclencheur.
- [ ] Chaque sauvegarde affiche son état réel et conserve le brouillon en cas d'échec.
- [ ] « Crée un point à 9 h en semaine » crée une routine via le MCP, visible ensuite dans le web.
- [ ] « Surveille les échecs de main » prépare le bon trigger ; OAuth manquant reste explicite.
- [ ] Filtre faux : aucune tâche admise ; filtre invalide : erreur visible, aucun lancement implicite.
- [ ] Modification d'une routine désactivée sans changement d'activation : elle reste désactivée.
- [ ] Rejeu d'une commande identique sans doublon ; entrée différente sous le même ID refusée.
- [ ] Modification agent visible dans les réglages ouverts ; conflit web/agent protégé.
- [ ] Aucun secret exposé ; accès étrangers, enfants et mandats révoqués couverts.
- [ ] Thème clair, contraste, zoom, mouvement réduit et états vides/erreurs vérifiés.
- [ ] Navigation et ouverture des panneaux ne réveillent aucune Box ; bundle mesuré avant/après.

## Test Plan

- Unit: schémas/catalogue de capacités, forme des résultats et compatibilité des noms d'opérations.
- Integration: PostgreSQL, parité web/MCP, commandes idempotentes et conflits, autorisation, révisions
  concurrentes, notifications après commit uniquement. Garder les tests crash/routines/triggers existants.
- E2E / manual: agent-browser desktop et mobile, clavier, zoom, création, réglages, retour navigateur,
  échec de sauvegarde, reconnexion ; fixtures locales et runtime Linux pour les parcours agent.
- Regression: suite existante `python3 scripts/verify.py --postgres 18`, tests web Vitest et build.
  Aucun nouveau workflow ou job CI. Une nouvelle distribution MCP exige aussi sa validation binaire
  et un canary Box borné avant publication ; archiver les seules machines de test ensuite.

## Rollout

Séquence d'implémentation proposée, chaque étape avec résultat observable :

1. **Fondations visuelles** : tokens clairs, typographie, avatars, boutons, champs et états.
   Livrable : un écran de chat de référence et sa variante mobile.
2. **Navigation et chat** : sidebar courte, menu compte, accueil vide, compositeur et accès activité.
   Livrable : navigation complète en conservant URLs et brouillons.
3. **Réglages progressifs** : index et sous-vues, profil, applications, automatisations, équipe/partage.
   Livrable : parcours utilisables sans ouvrir plusieurs panneaux ni perdre de capacités.
4. **Parité MCP** : catalogue, schémas, contrat de résultat et garanties de rejeu, services partagés.
   Cette étape peut avancer en parallèle de 1–2 une fois son contrat fixé.
5. **Web et agent cohérents** : reçus, invalidations, révisions et conflits d'édition ; parcours naturels.
6. **Finitions et publication** : navigateur, accessibilité, performance, suite complète, revue du diff,
   puis déploiement avec vérification du code réellement exécuté.

Garder la stack locale Herdr demandée par l'utilisateur ouverte pour inspection. Arrêter les
ressources de validation séparées ; ne pas confondre ce serveur de travail avec une machine de test.
Aucune promesse de délai chiffré avant le premier diff de navigation et l'audit complet de parité.

## Rollback

Commits distincts pour fondations, navigation, rubriques et contrat MCP. Restaurer le code précédent
sans supprimer les profils, configurations ni historiques. Garder les anciennes opérations MCP
compatibles pendant la transition et les migrations de révision additives. Pas de nouveau feature flag.

## Risks

- Réduire les boutons peut cacher les actions : entrées nommées et alternatives clavier/tactiles,
  aucun contrôle essentiel visible uniquement au survol.
- Autosave + agent peut provoquer des écrasements : contrôle de révision avant activation de l'autosave.
- L'UI peut afficher un succès avant l'effet distant : reçus fondés sur les états persistés distincts.
- Une abstraction de capacités trop générique alourdirait le produit : catalogue typé minimal,
  services explicites et aucun second routeur métier.

## Open Questions

Aucune question bloquante pour réaliser cette proposition. Hypothèses non bloquantes : « Maison »
est la direction visuelle et le thème reste clair indépendamment du système. La langue actuelle de l'app est conservée ;
une traduction complète n'est pas incluse dans cette passe.

## Handoff

- Spec name: Maison — interface et MCP de contrôle.
- Chosen scope: refonte des parcours existants, parité et ergonomie du MCP, sans nouveau runtime.
- Key decisions: menu court, réglages progressifs, identité portée par les companions, mêmes services web/MCP.
- Highest-risk areas: autosave concurrent, visibilité des états asynchrones, droits des enfants et des connexions.
- Acceptance criteria: voir checklist observable ci-dessus.
- Open questions: aucune bloquante ; hypothèses explicites dans la section précédente.
