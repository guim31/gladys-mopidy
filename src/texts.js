// -----------------------------------------------------------------------------
// Texts the integration sends to Gladys outside the widget (src/widgets.js):
// connection status, errors, the "Test the connection" report, the scene
// action errors. Four languages, the four of the Gladys interface; German says
// "du", Spanish "usted". test/i18n.test.js checks every table.
// -----------------------------------------------------------------------------

import { ERROR_KINDS } from './mopidy/client.js';

export const INIT_FAILED = {
  en: 'Initialization failed, check the integration logs.',
  fr: "L'initialisation a échoué, consultez les logs de l'intégration.",
  de: 'Initialisierung fehlgeschlagen, sieh dir die Protokolle der Integration an.',
  es: 'La inicialización ha fallado, consulte los registros de la integración.',
};

export const CONNECTION_TEXT = {
  noPlayer: {
    en: 'Enter the address of your Mopidy server in the configuration.',
    fr: "Saisissez l'adresse de votre serveur Mopidy dans la configuration.",
    de: 'Gib die Adresse deines Mopidy-Servers in der Konfiguration ein.',
    es: 'Introduzca la dirección de su servidor Mopidy en la configuración.',
  },
  invalidAddress: {
    en: 'Address not understood, e.g. 192.168.1.20 or 192.168.1.20:6680',
    fr: 'Adresse incomprise, ex. 192.168.1.20 ou 192.168.1.20:6680',
    de: 'Adresse nicht verstanden, z. B. 192.168.1.20 oder 192.168.1.20:6680',
    es: 'Dirección no válida, p. ej. 192.168.1.20 o 192.168.1.20:6680',
  },
  connecting: {
    en: 'connecting…',
    fr: 'connexion…',
    de: 'verbinde…',
    es: 'conectando…',
  },
};

// One short explanation per error kind (src/mopidy/client.js).
export const ERROR_TEXT = {
  [ERROR_KINDS.UNREACHABLE]: {
    en: 'does not answer',
    fr: 'ne répond pas',
    de: 'antwortet nicht',
    es: 'no responde',
  },
  [ERROR_KINDS.NOT_MOPIDY]: {
    en: 'no Mopidy-HTTP at this address and port (6680 by default)',
    fr: 'pas de Mopidy-HTTP à cette adresse et ce port (6680 par défaut)',
    de: 'kein Mopidy-HTTP unter dieser Adresse und diesem Port (standardmäßig 6680)',
    es: 'no hay Mopidy-HTTP en esta dirección y puerto (6680 por defecto)',
  },
  [ERROR_KINDS.FORBIDDEN]: {
    en: 'access refused (a proxy in front of Mopidy?)',
    fr: 'accès refusé (un proxy devant Mopidy ?)',
    de: 'Zugriff verweigert (ein Proxy vor Mopidy?)',
    es: 'acceso denegado (¿un proxy delante de Mopidy?)',
  },
  [ERROR_KINDS.COMMAND]: {
    en: 'command refused, see the logs',
    fr: 'commande refusée, voir les logs',
    de: 'Befehl abgelehnt, sieh in den Protokollen nach',
    es: 'orden rechazada, consulte los registros',
  },
};

// The "Test the connection" report, one line per player.
export const REPORT_TEXT = {
  en: {
    playing: 'playing',
    paused: 'paused',
    stopped: 'stopped',
    volume: (volume) => `volume ${volume} %`,
    noVolume: 'no volume control',
    playlists: (count) => `${count} playlist(s)`,
    noEvents: 'no live events (WebSocket closed), read every 30 s',
  },
  fr: {
    playing: 'en lecture',
    paused: 'en pause',
    stopped: 'arrêté',
    volume: (volume) => `volume ${volume} %`,
    noVolume: 'pas de réglage du volume',
    playlists: (count) => `${count} playlist(s)`,
    noEvents: 'pas d’événements en direct (WebSocket fermé), lu toutes les 30 s',
  },
  de: {
    playing: 'spielt',
    paused: 'pausiert',
    stopped: 'gestoppt',
    volume: (volume) => `Lautstärke ${volume} %`,
    noVolume: 'keine Lautstärkeregelung',
    playlists: (count) => `${count} Playlist(s)`,
    noEvents: 'keine Live-Ereignisse (WebSocket geschlossen), alle 30 s gelesen',
  },
  es: {
    playing: 'reproduciendo',
    paused: 'en pausa',
    stopped: 'detenido',
    volume: (volume) => `volumen ${volume} %`,
    noVolume: 'sin control de volumen',
    playlists: (count) => `${count} lista(s) de reproducción`,
    noEvents: 'sin eventos en directo (WebSocket cerrado), leído cada 30 s',
  },
};

// Errors of the scene actions, the device commands and the widget buttons.
export const ACTION_TEXT = {
  noPlayer: {
    en: 'No Mopidy server is configured.',
    fr: "Aucun serveur Mopidy n'est configuré.",
    de: 'Kein Mopidy-Server ist konfiguriert.',
    es: 'No hay ningún servidor Mopidy configurado.',
  },
  unknownPlayer: {
    en: 'This server is no longer in the configuration.',
    fr: "Ce serveur n'est plus dans la configuration.",
    de: 'Dieser Server ist nicht mehr in der Konfiguration.',
    es: 'Este servidor ya no está en la configuración.',
  },
  unreachable: {
    en: 'The Mopidy server does not answer.',
    fr: 'Le serveur Mopidy ne répond pas.',
    de: 'Der Mopidy-Server antwortet nicht.',
    es: 'El servidor Mopidy no responde.',
  },
  invalidUri: {
    en: 'Give a web address (http:// or https://) or a Mopidy URI (file:, local:, tunein:…).',
    fr: 'Indiquez une adresse web (http:// ou https://) ou une URI Mopidy (file:, local:, tunein:…).',
    de: 'Gib eine Webadresse (http:// oder https://) oder eine Mopidy-URI (file:, local:, tunein:…) an.',
    es: 'Indique una dirección web (http:// o https://) o una URI de Mopidy (file:, local:, tunein:…).',
  },
  notPlayable: {
    en: 'No Mopidy extension can play this address (is its backend installed?).',
    fr: 'Aucune extension de Mopidy ne sait lire cette adresse (son backend est-il installé ?).',
    de: 'Keine Mopidy-Erweiterung kann diese Adresse abspielen (ist ihr Backend installiert?).',
    es: 'Ninguna extensión de Mopidy puede reproducir esta dirección (¿está instalado su backend?).',
  },
  notStarted: {
    en: 'Mopidy could not play this address.',
    fr: "Mopidy n'a pas pu lire cette adresse.",
    de: 'Mopidy konnte diese Adresse nicht abspielen.',
    es: 'Mopidy no ha podido reproducir esta dirección.',
  },
  noVolume: {
    en: 'This server has no volume control (mixer = none in mopidy.conf).',
    fr: "Ce serveur n'a pas de réglage du volume (mixer = none dans mopidy.conf).",
    de: 'Dieser Server hat keine Lautstärkeregelung (mixer = none in mopidy.conf).',
    es: 'Este servidor no tiene control de volumen (mixer = none en mopidy.conf).',
  },
  noPlaylistName: {
    en: 'Give the name of a Mopidy playlist.',
    fr: "Indiquez le nom d'une playlist de Mopidy.",
    de: 'Gib den Namen einer Mopidy-Playlist an.',
    es: 'Indique el nombre de una lista de reproducción de Mopidy.',
  },
  playlistEmpty: {
    en: 'This playlist has no track Mopidy can play.',
    fr: "Cette playlist n'a aucun morceau que Mopidy sache lire.",
    de: 'Diese Playlist hat keinen Titel, den Mopidy abspielen kann.',
    es: 'Esta lista no tiene ninguna pista que Mopidy pueda reproducir.',
  },
  noQuery: {
    en: 'Give what to search: an artist, an album, a title.',
    fr: 'Indiquez quoi chercher : un artiste, un album, un titre.',
    de: 'Gib an, was gesucht werden soll: ein Interpret, ein Album, ein Titel.',
    es: 'Indique qué buscar: un artista, un álbum, un título.',
  },
  nothingFound: {
    en: 'The Mopidy library has no track for this search.',
    fr: "La bibliothèque de Mopidy n'a aucun morceau pour cette recherche.",
    de: 'Die Mopidy-Bibliothek hat keinen Titel für diese Suche.',
    es: 'La biblioteca de Mopidy no tiene ninguna pista para esta búsqueda.',
  },
  folderNotPlayable: {
    en: 'A folder cannot be played: open it and play what it holds.',
    fr: 'Un dossier ne se lit pas : ouvrez-le et lancez ce qu’il contient.',
    de: 'Ein Ordner kann nicht abgespielt werden: öffne ihn und spiele seinen Inhalt ab.',
    es: 'Una carpeta no se puede reproducir: ábrala y reproduzca lo que contiene.',
  },
  tooLarge: {
    en: 'Mopidy answered with too much at once (over 5 MB): open a smaller folder or refine the search.',
    fr: 'Mopidy a répondu avec trop de données d’un coup (plus de 5 Mo) : ouvrez un dossier plus petit ou affinez la recherche.',
    de: 'Mopidy hat zu viel auf einmal geantwortet (über 5 MB): Öffne einen kleineren Ordner oder verfeinere die Suche.',
    es: 'Mopidy ha respondido con demasiados datos a la vez (más de 5 MB): abra una carpeta más pequeña o afine la búsqueda.',
  },
  notInQueue: {
    en: 'This item is no longer in the queue.',
    fr: "Cet élément n'est plus dans la file d'attente.",
    de: 'Dieser Eintrag ist nicht mehr in der Warteschlange.',
    es: 'Este elemento ya no está en la cola.',
  },
  refused: {
    en: 'Mopidy refused the command, see the logs of the integration.',
    fr: "Mopidy a refusé la commande, voir les logs de l'intégration.",
    de: 'Mopidy hat den Befehl abgelehnt, sieh in den Protokollen der Integration nach.',
    es: 'Mopidy ha rechazado la orden, consulte los registros de la integración.',
  },
};

// The entry points of the catalog (Gladys 5.3 music panel), next to Mopidy's own.
export const CATALOG_TEXT = {
  playlists: {
    en: 'Playlists',
    fr: 'Playlists',
    de: 'Playlists',
    es: 'Listas de reproducción',
  },
};

// Messages with a value in them.
export const MESSAGES = {
  en: {
    playlistNotFound: (name, names) =>
      `No playlist "${name}" in Mopidy.${names ? ` Playlists: ${names}` : ''}`,
  },
  fr: {
    playlistNotFound: (name, names) =>
      `Aucune playlist « ${name} » dans Mopidy.${names ? ` Playlists : ${names}` : ''}`,
  },
  de: {
    playlistNotFound: (name, names) =>
      `Keine Playlist „${name}“ in Mopidy.${names ? ` Playlists: ${names}` : ''}`,
  },
  es: {
    playlistNotFound: (name, names) =>
      `No hay ninguna lista «${name}» en Mopidy.${names ? ` Listas: ${names}` : ''}`,
  },
};

export const LANGUAGE_FALLBACK = 'en';

/** "Name: text", with the space French puts before a colon. */
export const labelled = (name, text, language) =>
  `${name}${language === 'fr' ? ' : ' : ': '}${text}`;
export const pick = (text, language) => text[language] ?? text[LANGUAGE_FALLBACK];

/** Shorten to `max` characters, with an ellipsis. */
export const fit = (text, max) =>
  text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text;

/**
 * An error a user can read, in one language: the texts of this file thrown
 * as a plain Error message (Gladys shows the message of a failed command).
 */
export class UserError extends Error {
  /**
   * @param {Record<string, string>} text multi-language text
   * @param {string} language
   */
  constructor(text, language) {
    super(fit(pick(text, language), 200));
    this.name = 'UserError';
    this.text = text;
  }
}

/** Remove what must never reach a log or a message: credentials in URLs. */
export function safeText(text) {
  return String(text ?? '').replace(/([a-z][a-z0-9+.-]*:\/\/)[^/\s@]*@/gi, '$1');
}

/**
 * An address as the logs show it: a web address loses its path and query
 * (the voice of "Talk on a speaker" carries a token and the spoken text);
 * a Mopidy URI (`file:`, `tunein:`…) is kept.
 */
export function shownUri(uri) {
  const text = safeText(uri);
  const web = /^(https?:\/\/[^/?#\s]+)([/?#].*)?$/i.exec(text);
  if (!web) {
    return text;
  }
  return web[2] && web[2] !== '/' ? `${web[1]}/…` : web[1];
}
