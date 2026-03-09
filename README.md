# MCP Planning RH - Deploiement Cloud (Render)

Ce serveur MCP expose des outils planning/pointage/RH pour Base44.

## 1) Preparer le code

```bash
cd "/Users/sebastienchauby/Documents/New project"
git init
git add .
git commit -m "MCP server ready for cloud deploy"
```

Puis pousse le repo sur GitHub.

## 2) Deployer sur Render

1. Ouvre [render.com](https://render.com) et connecte ton GitHub.
2. Clique `New +` -> `Blueprint`.
3. Selectionne ce repo (Render lira `render.yaml`).
4. Renseigne les variables privees demandees:
   - `BASE44_APP_ID`: `69aea2266ed688f1f4067cae`
   - `BASE44_TOKEN`: ton token Base44
   - `MCP_SHARED_SECRET`: une longue cle secrete (ex: 32+ caracteres)
5. Lance le deploy.

URL finale attendue:

```text
https://<ton-service>.onrender.com/mcp
```

## 3) Configurer Base44 (champ par champ)

Dans `Parametres du compte -> Connexions MCP -> Ajouter MCP`:

- Nom: `MCP Planning RH Cloud`
- URL: `https://<ton-service>.onrender.com/mcp`
- Authentification: `Non requise`
- En-tetes personnalises:
  - Cle: `x-mcp-secret`
  - Valeur: la meme valeur que `MCP_SHARED_SECRET` sur Render

Puis `Tester et ajouter`.

## 4) Verification rapide

Dans le chat de l'editeur Base44:

1. `Liste les outils MCP disponibles`
2. `Execute l'outil ping`
3. `Execute planning_data_source_status`

## Notes importantes

- Le mode cloud donne une URL stable (contrairement aux tunnels locaux).
- Si `BASE44_TOKEN` expire, le MCP restera connecte mais les outils Base44 pourront echouer.
- Regenerer toute cle API exposee dans une capture d'ecran.
