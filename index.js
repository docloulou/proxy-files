// bufferService.js

const express = require('express');
const http = require('http');
const https = require('https');
const urlModule = require('url');
const dotenv = require('dotenv');

dotenv.config();

const app = express();

// Configuration des timeouts
const TIMEOUT_CONNEXION = 30000; // 30 secondes
const TIMEOUT_SOCKET = 60000;    // 60 secondes

// Clé API pour la sécurité
const API_KEY = process.env.API_KEY || 'default_key_for_dev';

// Système de suivi des connexions actives
const connectionsActives = new Map();
let connectionCounter = 0;

// Middleware pour vérifier la clé API
const verifyApiKey = (req, res, next) => {
  const providedKey = req.query.key;
  
  if (!providedKey || providedKey !== API_KEY) {
    console.log('Tentative d\'accès non autorisée: clé API invalide ou manquante');
    return res.status(401).send('Accès non autorisé: clé API invalide ou manquante');
  }
  
  next();
};

function logConnectionsActives() {
  console.log('\n=== État des connexions ===');
  console.log(`Nombre total de connexions actives: ${connectionsActives.size}`);
  connectionsActives.forEach((info, id) => {
    console.log(`[ID: ${id}] URL: ${info.url} | Bytes transmis: ${info.bytesTransmis} | Durée: ${Math.floor((Date.now() - info.startTime)/1000)}s`);
  });
  console.log('========================\n');
}

// Configuration du serveur pour éviter les fuites de mémoire
app.set('keepAliveTimeout', TIMEOUT_CONNEXION);
app.set('headersTimeout', TIMEOUT_SOCKET);

// Route de health check (sans authentification)
app.get('/health', (req, res) => {
  res.status(200).json({
    status: 'UP',
    connections: connectionsActives.size,
    uptime: Math.floor(process.uptime())
  });
});

/**
 * Point d'entrée pour la mise en tampon.
 * Emby doit appeler l'URL sous la forme :
 * http://<ip-de-votre-service-tampon>:3000/url?url=<url_source_du_strm>&key=<votre_api_key>
 */
app.get('/url', verifyApiKey, (req, res) => {
  const connectionId = ++connectionCounter;
  const startTime = Date.now();
  
  // Ajouter la nouvelle connexion au suivi
  connectionsActives.set(connectionId, {
    url: req.query.url,
    bytesTransmis: 0,
    startTime: startTime
  });
  
  logConnectionsActives();

  // Configurer les timeouts de la réponse
  res.setTimeout(TIMEOUT_SOCKET, () => {
    console.log('Timeout de la réponse atteint');
    if (!res.headersSent) {
      res.status(504).send('Gateway Timeout');
    }
    res.end();
  });

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
      // Configurer le timeout pour la réponse distante
      remoteResponse.setTimeout(TIMEOUT_CONNEXION, () => {
        console.log('Timeout de la réponse distante atteint');
        remoteResponse.destroy();
      });

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
          if (fatalErrorRetryCount >= 2) {
            console.error(`Erreur ${remoteResponse.statusCode} persistante après 2 tentatives, abandon.`);
            if (!res.headersSent) {
              res.status(remoteResponse.statusCode).send(`Erreur ${remoteResponse.statusCode} persistante après 2 tentatives.`);
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
        if (streamingTermine) {
          remoteResponse.destroy();
          return;
        }

        bytesTransmis += chunk.length;
        // Mettre à jour les bytes transmis dans le suivi
        if (connectionsActives.has(connectionId)) {
          connectionsActives.get(connectionId).bytesTransmis = bytesTransmis;
          connectionsActives.get(connectionId).url = sourceUrl; // Met à jour l'URL en cas de redirection
        }
        
        const ok = res.write(chunk);
        if (!ok) {
          remoteResponse.pause();
          res.once('drain', () => {
            if (!streamingTermine) {
              remoteResponse.resume();
            }
          });
        }
      });

      // Fin de la transmission
      remoteResponse.on('end', () => {
        console.log('Transmission terminée depuis la source.');
        streamingTermine = true;
        remoteResponse.destroy();
        // Supprimer la connexion du suivi
        connectionsActives.delete(connectionId);
        logConnectionsActives();
        res.end();
      });

      // Gestion des erreurs sur le flux distant
      remoteResponse.on('error', err => {
        console.error('Erreur sur le stream distant :', err);
        remoteResponse.destroy();
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

    // Configurer le timeout pour la requête
    remoteRequest.setTimeout(TIMEOUT_CONNEXION, () => {
      console.log('Timeout de la requête atteint');
      remoteRequest.destroy();
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

  // Nettoyer les ressources si le client se déconnecte
  req.on('close', () => {
    console.log('Client déconnecté, nettoyage des ressources');
    streamingTermine = true;
    // Supprimer la connexion du suivi
    connectionsActives.delete(connectionId);
    logConnectionsActives();
    if (!res.headersSent) {
      res.end();
    }
  });

  // Lancer la première requête à partir de l'offset initial
  lancerRequete(totalStart);
});

// Afficher périodiquement l'état des connexions
setInterval(logConnectionsActives, 2000); // Toutes les 10 secondes

// Démarrer le serveur sur le port 3000 (ou le port défini dans la variable d'environnement PORT)
const PORT = process.env.PORT || 3000;
const server = app.listen(PORT, () => {
  console.log(`Service tampon en écoute sur le port ${PORT}`);
});

// Configurer les timeouts du serveur
server.keepAliveTimeout = TIMEOUT_CONNEXION;
server.headersTimeout = TIMEOUT_SOCKET;
