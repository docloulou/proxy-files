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
const INACTIVITY_TIMEOUT = 20000; // 20 secondes d'inactivité avant de considérer une connexion comme fantôme
const CLIENT_INACTIVITY_THRESHOLD = 10000; // 10 secondes sans consommation côté client = connexion fantôme

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
  // Clear console before each refresh
  console.clear();
  
  // Get current timestamp for calculations
  const now = Date.now();
  
  // Calculate total bytes and average speed
  let totalBytes = 0;
  let totalSpeed = 0;
  
  connectionsActives.forEach(info => {
    totalBytes += info.bytesTransmis;
    const duration = Math.max(1, (now - info.startTime) / 1000);
    totalSpeed += info.bytesTransmis / duration;
  });
  
  // Format total data
  let totalVolumeStr = 'N/A';
  if (totalBytes > 0) {
    if (totalBytes > 1073741824) { // > 1GB
      totalVolumeStr = `${(totalBytes / 1073741824).toFixed(2)} GB`;
    } else if (totalBytes > 1048576) { // > 1MB
      totalVolumeStr = `${(totalBytes / 1048576).toFixed(2)} MB`;
    } else {
      totalVolumeStr = `${(totalBytes / 1024).toFixed(2)} KB`;
    }
  }
  
  // Format total speed
  let totalSpeedStr = 'N/A';
  if (totalSpeed > 0) {
    if (totalSpeed > 1048576) { // > 1MB/s
      totalSpeedStr = `${(totalSpeed / 1048576).toFixed(2)} MB/s`;
    } else {
      totalSpeedStr = `${(totalSpeed / 1024).toFixed(2)} KB/s`;
    }
  }
  
  // Display server uptime
  const uptime = Math.floor(process.uptime());
  const uptimeHours = Math.floor(uptime / 3600);
  const uptimeMinutes = Math.floor((uptime % 3600) / 60);
  const uptimeSeconds = uptime % 60;
  const uptimeStr = `${uptimeHours}h ${uptimeMinutes}m ${uptimeSeconds}s`;
  
  // Header with server stats
  console.log('\n╔═════════════════════════════════════════════════════╗');
  console.log('║             DASHBOARD STREAMING PROXY               ║');
  console.log('╠═════════════════════════════════════════════════════╣');
  console.log(`║ Connexions: ${connectionsActives.size.toString().padEnd(5)} │ Uptime: ${uptimeStr.padEnd(15)} ║`);
  console.log(`║ Volume total: ${totalVolumeStr.padEnd(10)} │ Vitesse: ${totalSpeedStr.padEnd(12)} ║`);
  console.log('╠═════════════════════════════════════════════════════╣');
  
  if (connectionsActives.size > 0) {
    console.log('║ ID │ URL                  │ VITESSE  │ VOLUME   │ DURÉE  ║ ÉTAT ║');
    console.log('╠════╪══════════════════════╪══════════╪══════════╪════════╪══════╣');
    
    connectionsActives.forEach((info, id) => {
      // Calculate transmission speed (bytes per second)
      const dureeSeconds = Math.max(1, (now - info.startTime) / 1000);
      const vitesse = info.bytesTransmis / dureeSeconds;
      
      // Format speed in appropriate units (KB/s or MB/s)
      let vitesseStr;
      if (vitesse > 1048576) { // > 1MB/s
        vitesseStr = `${(vitesse / 1048576).toFixed(2)} MB/s`;
      } else {
        vitesseStr = `${(vitesse / 1024).toFixed(2)} KB/s`;
      }
      
      // Format total data in appropriate units
      let volumeStr;
      if (info.bytesTransmis > 1073741824) { // > 1GB
        volumeStr = `${(info.bytesTransmis / 1073741824).toFixed(2)} GB`;
      } else if (info.bytesTransmis > 1048576) { // > 1MB
        volumeStr = `${(info.bytesTransmis / 1048576).toFixed(2)} MB`;
      } else {
        volumeStr = `${(info.bytesTransmis / 1024).toFixed(2)} KB`;
      }
      
      // Format duration
      const minutes = Math.floor(dureeSeconds / 60);
      const seconds = Math.floor(dureeSeconds % 60);
      const dureeStr = minutes > 0 ? `${minutes}m ${seconds}s` : `${seconds}s`;
      
      // Shorten URL if too long
      const shortUrl = info.url.length > 20 ? info.url.substring(0, 17) + '...' : info.url;
      
      // Calculate status
      let etats = 'ACTIF';
      const inactivityTime = now - info.lastActivity;
      const clientInactivityTime = now - info.lastClientActivity;
      
      if (clientInactivityTime > CLIENT_INACTIVITY_THRESHOLD) {
        etats = 'FANTÔME';
      } else if (inactivityTime > INACTIVITY_TIMEOUT) {
        etats = 'STALL';
      }
      
      console.log(`║ ${id.toString().padEnd(2)} │ ${shortUrl.padEnd(20)} │ ${vitesseStr.padEnd(8)} │ ${volumeStr.padEnd(8)} │ ${dureeStr.padEnd(6)} ║ ${etats} ║`);
    });
  } else {
    console.log('║           Aucune connexion active                    ║');
  }
  console.log('╚═════════════════════════════════════════════════════╝');
}

// Fonction pour nettoyer les connexions fantômes
function nettoyerConnexionsFantomes() {
  const now = Date.now();
  let nbrNettoyees = 0;
  
  connectionsActives.forEach((info, id) => {
    // Cas 1: Détection d'inactivité générale
    const inactivityTime = now - info.lastActivity;
    if (inactivityTime > INACTIVITY_TIMEOUT) {
      console.log(`Connexion inactive (ID: ${id}) détectée après ${Math.floor(inactivityTime/1000)}s, nettoyage...`);
      if (info.terminerConnexion) {
        info.terminerConnexion();
      }
      connectionsActives.delete(id);
      nbrNettoyees++;
      return;
    }
    
    // Cas 2: Le serveur reçoit des données de la source mais le client ne les consomme pas
    const clientInactivityTime = now - info.lastClientActivity;
    const serverIsActive = now - info.lastActivity < 5000; // Le serveur a reçu des données récemment
    
    if (serverIsActive && clientInactivityTime > CLIENT_INACTIVITY_THRESHOLD) {
      console.log(`Connexion fantôme (ID: ${id}) détectée: client inactif depuis ${Math.floor(clientInactivityTime/1000)}s mais serveur actif, nettoyage...`);
      if (info.terminerConnexion) {
        info.terminerConnexion();
      }
      connectionsActives.delete(id);
      nbrNettoyees++;
      return;
    }
    
    // Cas 3: Détection de mise en buffer excessive (le client ne consomme pas assez vite)
    if (info.bufferSize && info.bufferSize > 50 * 1024 * 1024) { // Si buffer > 50MB
      console.log(`Connexion problématique (ID: ${id}) détectée: buffer excessif (${Math.floor(info.bufferSize/1024/1024)}MB), nettoyage...`);
      if (info.terminerConnexion) {
        info.terminerConnexion();
      }
      connectionsActives.delete(id);
      nbrNettoyees++;
      return;
    }
  });
  
  if (nbrNettoyees > 0) {
    console.log(`${nbrNettoyees} connexion(s) problématique(s) nettoyée(s)`);
    logConnectionsActives();
  }
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
    startTime: startTime,
    lastActivity: startTime,      // Dernière activité côté serveur (réception de données depuis la source)
    lastClientActivity: startTime, // Dernière activité côté client (envoi réussi au client)
    bufferSize: 0,                // Taille estimée du buffer
    terminerConnexion: null       // sera défini plus tard
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

  // Détecter si c'est un seek en vérifiant s'il y a des connexions existantes avec la même URL de base
  let isSeek = false;
  connectionsActives.forEach((info, id) => {
    if (id !== connectionId && info.url === baseUrl) {
      isSeek = true;
      console.log(`Seeking détecté: nouvelle connexion ${connectionId} pour ${baseUrl}, l'ancienne connexion ${id} sera nettoyée.`);
      // Si c'est une opération de seeking, marquer les anciennes connexions avec la même URL comme terminées
      if (info.terminerConnexion) {
        info.terminerConnexion();
      }
      connectionsActives.delete(id);
    }
  });

  console.log(`Streaming de ${sourceUrl} à partir de l'octet ${clientRangeStart}${isSeek ? ' (seeking)' : ''}`);

  // Variables pour suivre la progression dans le flux
  let bytesTransmis = 0;
  const totalStart = clientRangeStart;  // point de départ initial (pour le seeking)
  let streamingTermine = false;
  let redirectRetryCount = 0; // Compteur de tentatives sur l'URL de redirection
  let fatalErrorRetryCount = 0; // Compteur pour les erreurs 404 et 503
  let remoteRequestGlobal = null; // Pour pouvoir l'annuler au besoin
  let remoteResponseGlobal = null; // Pour pouvoir l'annuler au besoin

  // Définir la fonction de terminaison pour cette connexion
  connectionsActives.get(connectionId).terminerConnexion = () => {
    console.log(`Terminaison forcée de la connexion ${connectionId}`);
    streamingTermine = true;
    if (remoteRequestGlobal) {
      remoteRequestGlobal.destroy();
    }
    if (remoteResponseGlobal) {
      remoteResponseGlobal.destroy();
    }
  };

  /**
   * Fonction qui lance la requête HTTP(S) vers la source à partir d'un offset donné.
   * En cas d'erreur, on tente de reprendre la connexion en ajoutant un délai.
   *
   * @param {number} offset - L'octet de départ pour la reprise du flux.
   */
  function lancerRequete(offset) {
    if (streamingTermine) {
      console.log(`Tentative de lancer une requête sur une connexion terminée (ID: ${connectionId})`);
      return;
    }

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
      remoteRequestGlobal = remoteRequest;
      remoteResponseGlobal = remoteResponse;
      
      // Mettre à jour l'activité côté serveur
      if (connectionsActives.has(connectionId)) {
        connectionsActives.get(connectionId).lastActivity = Date.now();
      }
      
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

        // Mise à jour de l'heure de dernière activité et des bytes transmis
        bytesTransmis += chunk.length;
        
        // Mettre à jour les bytes transmis dans le suivi
        if (connectionsActives.has(connectionId)) {
          const connexion = connectionsActives.get(connectionId);
          connexion.bytesTransmis = bytesTransmis;
          connexion.lastActivity = Date.now();
          connexion.url = sourceUrl; // Met à jour l'URL en cas de redirection
          
          // Augmenter la taille estimée du buffer
          connexion.bufferSize = (connexion.bufferSize || 0) + chunk.length;
        }
        
        const ok = res.write(chunk);
        if (!ok) {
          // Le client ne consomme pas assez vite, on doit mettre en pause
          remoteResponse.pause();
          
          // Ajouter un délai de sécurité pour détecter les clients bloqués
          const pauseTime = Date.now();
          const pauseCheckInterval = setInterval(() => {
            if (streamingTermine) {
              clearInterval(pauseCheckInterval);
              return;
            }
            
            const now = Date.now();
            const pauseDuration = now - pauseTime;
            
            // Si la pause dure trop longtemps, c'est probablement que le client est déconnecté
            if (pauseDuration > CLIENT_INACTIVITY_THRESHOLD) {
              console.log(`Pause excessive détectée (${Math.floor(pauseDuration/1000)}s) pour la connexion ${connectionId}, probable déconnexion client`);
              clearInterval(pauseCheckInterval);
              
              // Terminer la connexion
              streamingTermine = true;
              remoteResponse.destroy();
              connectionsActives.delete(connectionId);
              res.end();
              return;
            }
          }, 1000); // Vérifier toutes les secondes
          
          res.once('drain', () => {
            clearInterval(pauseCheckInterval);
            
            if (streamingTermine) {
              return;
            }
            
            // Le client a consommé les données, on peut reprendre le streaming
            if (connectionsActives.has(connectionId)) {
              const connexion = connectionsActives.get(connectionId);
              connexion.lastClientActivity = Date.now();
              
              // Réduire la taille estimée du buffer
              const connexion = connectionsActives.get(connectionId);
              connexion.bufferSize = Math.max(0, (connexion.bufferSize || 0) - chunk.length);
            }
            
            remoteResponse.resume();
          });
        } else {
          // Le client a consommé les données immédiatement
          if (connectionsActives.has(connectionId)) {
            connectionsActives.get(connectionId).lastClientActivity = Date.now();
            
            // Pas de buffer accumulé
            connectionsActives.get(connectionId).bufferSize = 0;
          }
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
setInterval(logConnectionsActives, 2000); // Toutes les 2 secondes

// Nettoyer périodiquement les connexions fantômes
setInterval(nettoyerConnexionsFantomes, 5000); // Toutes les 5 secondes

// Démarrer le serveur sur le port 3000 (ou le port défini dans la variable d'environnement PORT)
const PORT = process.env.PORT || 3000;
const server = app.listen(PORT, () => {
  console.log(`Service tampon en écoute sur le port ${PORT}`);
});

// Configurer les timeouts du serveur
server.keepAliveTimeout = TIMEOUT_CONNEXION;
server.headersTimeout = TIMEOUT_SOCKET;
