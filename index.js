// bufferService.js

const express = require('express');
const http = require('http');
const https = require('https');
const urlModule = require('url');

const app = express();

/**
 * Point d'entrée pour la mise en tampon.
 * Emby doit appeler l'URL sous la forme :
 * http://<ip-de-votre-service-tampon>:3000/url?url=<url_source_du_strm>
 */
app.get('/url', (req, res) => {
  // Récupération de l'URL source passée en paramètre de requête
  let sourceUrl = req.query.url;
  const baseUrl = req.query.url; // Garder l'URL originale
  if (!sourceUrl) {
    res.status(400).send("Paramètre 'url' manquant.");
    return;
  }

  // Analyse de l'en-tête Range envoyé par le client (Emby) pour supporter le seeking
  let clientRangeStart = 0;
  const rangeHeader = req.headers.range;
  if (rangeHeader) {
    const match = rangeHeader.match(/bytes=(\d+)-/);
    if (match) {
      clientRangeStart = parseInt(match[1], 10);
    }
  }

  console.log(`Streaming de ${sourceUrl} à partir de l'octet ${clientRangeStart}`);

  // Variables pour suivre la progression dans le flux
  let bytesTransmis = 0;
  const totalStart = clientRangeStart;  // point de départ initial (pour le seeking)
  let streamingTermine = false;
  let redirectRetryCount = 0; // Compteur de tentatives sur l'URL de redirection
  let fatalErrorRetryCount = 0; // Compteur pour les erreurs 404 et 503

  /**
   * Fonction qui lance la requête HTTP(S) vers la source à partir d'un offset donné.
   * En cas d'erreur, on tente de reprendre la connexion en ajoutant un délai.
   *
   * @param {number} offset - L'octet de départ pour la reprise du flux.
   */
  function lancerRequete(offset) {
    console.log(`Lancement de la requête depuis l'octet ${offset}`);

    // Si on a dépassé le nombre max de tentatives sur l'URL de redirection, on revient à l'URL de base
    if (sourceUrl !== baseUrl && redirectRetryCount >= 10) {
      console.log('Trop de tentatives sur l\'URL de redirection, retour à l\'URL de base');
      sourceUrl = baseUrl;
      redirectRetryCount = 0;
      fatalErrorRetryCount = 0; // Réinitialiser aussi le compteur d'erreurs fatales
    }

    // Préparer les options de la requête vers l'URL source
    const parsedUrl = urlModule.parse(sourceUrl);
    const options = {
      headers: {},
      followRedirect: false // We'll handle redirects manually
    };

    // Ajout de l'en-tête Range selon l'offset
    if (offset > 0) {
      options.headers.Range = `bytes=${offset}-`;
    } else if (rangeHeader) {
      options.headers.Range = rangeHeader;
    }

    // Choix du module en fonction du protocole (http ou https)
    const protocol = parsedUrl.protocol === 'https:' ? https : http;

    // Lancer la requête vers la source
    const remoteRequest = protocol.get(sourceUrl, options, remoteResponse => {
      // Handle redirects (status codes 301, 302, 303, 307, 308)
      if (remoteResponse.statusCode >= 300 && remoteResponse.statusCode < 400 && remoteResponse.headers.location) {
        console.log(`Suivre la redirection vers: ${remoteResponse.headers.location}`);
        sourceUrl = remoteResponse.headers.location; // Update the source URL
        lancerRequete(offset); // Retry with the new URL
        return;
      }

      // Vérifier le code de statut de la réponse distante et relancer en cas d'erreur
      if (remoteResponse.statusCode && (remoteResponse.statusCode < 200 || remoteResponse.statusCode >= 300) && remoteResponse.statusCode !== 206) {
        console.error(`Erreur de la réponse distante : ${remoteResponse.statusCode}, nouvelle tentative dans 1 seconde...`);
        
        // Gestion spéciale pour les erreurs 404 et 503
        if (remoteResponse.statusCode === 404 || remoteResponse.statusCode === 503) {
          fatalErrorRetryCount++;
          if (fatalErrorRetryCount >= 3) {
            console.error(`Erreur ${remoteResponse.statusCode} persistante après 3 tentatives, abandon.`);
            if (!res.headersSent) {
              res.status(remoteResponse.statusCode).send(`Erreur ${remoteResponse.statusCode} persistante après 3 tentatives.`);
            }
            streamingTermine = true;
            return;
          }
        }

        if (!streamingTermine) {
          if (sourceUrl !== baseUrl) {
            redirectRetryCount++;
          }
          setTimeout(() => {
            lancerRequete(totalStart + bytesTransmis);
          }, 1000);
        }
        return;
      }

      // Configurer les en-têtes de la réponse envoyée à Emby
      if (!res.headersSent) {
        if (remoteResponse.headers['content-range']) {
          res.setHeader('Content-Range', remoteResponse.headers['content-range']);
          res.statusCode = 206;
        } else {
          res.statusCode = 200;
        }
        if (remoteResponse.headers['content-type']) {
          res.setHeader('Content-Type', remoteResponse.headers['content-type']);
        }
        if (remoteResponse.headers['content-length']) {
          res.setHeader('Content-Length', remoteResponse.headers['content-length']);
        }
        res.setHeader('Accept-Ranges', 'bytes');
      }

      // Transmission des données depuis la source vers le client (Emby)
      remoteResponse.on('data', chunk => {
        bytesTransmis += chunk.length;
        const ok = res.write(chunk);
        if (!ok) {
          // Si le buffer de réponse est saturé, on suspend le flux jusqu'au drain
          remoteResponse.pause();
          res.once('drain', () => {
            remoteResponse.resume();
          });
        }
      });

      // Fin de la transmission
      remoteResponse.on('end', () => {
        console.log('Transmission terminée depuis la source.');
        streamingTermine = true;
        res.end();
      });

      // Gestion des erreurs sur le flux distant
      remoteResponse.on('error', err => {
        console.error('Erreur sur le stream distant :', err);
        if (!streamingTermine) {
          if (sourceUrl !== baseUrl) {
            redirectRetryCount++;
          }
          console.log('Tentative de reprise dans 1 seconde...');
          setTimeout(() => {
            lancerRequete(totalStart + bytesTransmis);
          }, 1000);
        }
      });
    });

    // Gestion des erreurs sur la requête HTTP(S)
    remoteRequest.on('error', err => {
      console.error('Erreur sur la requête distante :', err);
      if (!streamingTermine) {
        if (sourceUrl !== baseUrl) {
          redirectRetryCount++;
        }
        console.log('Tentative de reprise dans 1 seconde...');
        setTimeout(() => {
          lancerRequete(totalStart + bytesTransmis);
        }, 1000);
      }
    });
  }

  // Lancer la première requête à partir de l'offset initial
  lancerRequete(totalStart);
});

// Démarrer le serveur sur le port 3000 (ou le port défini dans la variable d'environnement PORT)
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Service tampon en écoute sur le port ${PORT}`);
});
