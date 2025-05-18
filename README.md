# Service Tampon (Buffer Service)

Service de proxification et mise en tampon pour le streaming Emby.

## Fonctionnalités

- Proxification des flux vidéo
- Gestion des redirections
- Support du seeking
- Protection par clé API
- Suivi des connexions actives
- Gestion des timeouts et des erreurs

## Prérequis

- Docker et Docker Compose installés sur votre système

## Installation et déploiement

1. Clonez ce dépôt sur votre serveur
```
git clone [url-du-repo] buffer-service
cd buffer-service
```

2. Créez un fichier `.env` basé sur l'exemple
```
cp env.example .env
```

3. Modifiez le fichier `.env` pour définir votre clé API sécurisée
```
nano .env
```

4. Construisez et démarrez le conteneur
```
docker-compose up -d
```

5. Vérifiez que le service fonctionne
```
docker-compose logs -f
```

## Utilisation

Une fois le service démarré, Emby peut accéder au flux via l'URL:
```
http://<ip-du-service>:3000/url?url=<url_source_du_strm>&key=<votre_api_key>
```

Exemple:
```
http://192.168.1.10:3000/url?url=https://example.com/video.mp4&key=your_secure_api_key_here
```

## Maintenance

### Redémarrer le service
```
docker-compose restart
```

### Mettre à jour le code
```
git pull
docker-compose down
docker-compose up -d --build
```

### Consulter les logs
```
docker-compose logs -f
```

## Configuration

Les variables d'environnement suivantes peuvent être configurées dans le fichier `.env`:

- `API_KEY`: Clé d'API pour sécuriser l'accès (obligatoire)
- `PORT`: Port d'écoute du service (défaut: 3000)