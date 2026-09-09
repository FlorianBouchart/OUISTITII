/**
 * google-token.mjs — obtenir le jeton de renouvellement Google, une seule fois.
 *
 * Ce jeton permet au Worker de déposer les souvenirs dans le Drive des mariés
 * sans jamais leur redemander de se connecter. Il ne s'obtient qu'une fois, et
 * ne quitte ensuite jamais les secrets du Worker.
 *
 *   npm run google:token
 *
 * Le script demande les identifiants, ouvre une page d'autorisation, attend le
 * retour de Google, puis affiche le jeton à recopier dans
 * `wrangler secret put GOOGLE_REFRESH_TOKEN`.
 *
 * Rien n'est écrit sur le disque : ni les identifiants, ni le jeton.
 */

import http from 'node:http';
import readline from 'node:readline';
import { exec } from 'node:child_process';

/**
 * Les identifiants sont demandés à la saisie plutôt que passés en arguments :
 * une ligne de commande reste dans l'historique du terminal, et s'affiche dans
 * la liste des processus. Le secret est masqué pendant la frappe.
 */
function demander(question, masquer = false) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

    if (masquer) {
      const write = rl._writeToOutput.bind(rl);
      rl._writeToOutput = (chaine) => {
        if (chaine.includes(question)) write(chaine);
        else rl.output.write('*');
      };
    }

    rl.question(question, (reponse) => {
      if (masquer) rl.output.write('\n');
      rl.close();
      resolve(reponse.trim());
    });
  });
}

const [argId, argSecret] = process.argv.slice(2);

console.log('\n═══ Autorisation Google Drive ═══');
console.log('\nCes deux valeurs viennent de Google Cloud → Clients.');
console.log('Elles restent sur cet ordinateur : elles ne sont ni enregistrées,');
console.log('ni envoyées ailleurs qu\'à Google.\n');

const clientId = argId || (await demander('ID client        : '));
const clientSecret = argSecret || (await demander('Code secret      : ', true));

if (!clientId || !clientSecret) {
  console.error('\nIl manque une des deux valeurs.');
  process.exit(1);
}

const PORT = 4477;
const REDIRECT = `http://localhost:${PORT}`;

// drive.file : l'application ne voit que les fichiers qu'elle a elle-même
// déposés. Elle ne peut ni lire ni toucher au reste du Drive.
const SCOPE = 'https://www.googleapis.com/auth/drive.file';

const authUrl =
  'https://accounts.google.com/o/oauth2/v2/auth?' +
  new URLSearchParams({
    client_id: clientId,
    redirect_uri: REDIRECT,
    response_type: 'code',
    scope: SCOPE,
    access_type: 'offline',
    prompt: 'consent',
  });

const server = http.createServer(async (req, res) => {
  const code = new URL(req.url, REDIRECT).searchParams.get('code');
  if (!code) {
    res.writeHead(400).end('Aucun code reçu.');
    return;
  }

  const response = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      client_id: clientId,
      client_secret: clientSecret,
      redirect_uri: REDIRECT,
      grant_type: 'authorization_code',
    }),
  });
  const data = await response.json();

  if (!data.refresh_token) {
    res.writeHead(500).end('Google n\'a pas renvoyé de jeton de renouvellement.');
    console.error('\nRéponse de Google :', data);
    server.close();
    return;
  }

  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(
    '<h1 style="font-family:system-ui">C\'est bon.</h1>' +
    '<p style="font-family:system-ui">Vous pouvez fermer cet onglet et revenir au terminal.</p>'
  );

  console.log('\n═══ Jeton de renouvellement ═══\n');
  console.log(data.refresh_token);
  console.log('\nÀ enregistrer ainsi :\n');
  console.log('  npx wrangler secret put GOOGLE_REFRESH_TOKEN\n');
  server.close();
});

server.listen(PORT, () => {
  console.log('\nOuverture de la page d\'autorisation Google…');
  console.log('Si rien ne s\'ouvre, copiez cette adresse :\n');
  console.log(authUrl + '\n');
  exec(`open "${authUrl}"`);
});
