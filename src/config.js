// Default-Konfiguration für den TrailingBinanceBot
export const DEFAULT_CONFIG = {
    // Trading-Modus: 'live' für echten Handel, 'paper' für Papierhandel (Simulation)
    tradingMode: 'paper',

    // Log-Level: 'error', 'warn', 'info', 'debug'
    logLevel: 'info',

    // Intervall in Millisekunden, in dem der Bot nach neuen Handelsmöglichkeiten sucht
    refreshInterval: 60000, // 1 Minute

    // Intervall zur Berechnung der Volatilität (ATR) in Millisekunden
    volatilityUpdateInterval: 3600000, // 1 Stunde

    // Symbol (Handelspaar) für den Handel
    symbol: 'BTCUSDT',

    // Größe der Position in der Quote-Währung (z.B. USDT)
    positionSize: 1000, // USDT

    // Trailing-Stop Einstellungen
    trailingStop: {
        // Initiale Stop-Loss-Distanz in Prozent vom Einstiegspreis
        initialStopDistancePercent: 2,
        
        // Aktivierungsschwelle für Trailing in Prozent (Ab welchem Gewinn wird der Stop nachgezogen)
        activationThresholdPercent: 1,
        
        // Trailing-Distanz in Prozent vom höchsten erreichten Preis
        trailingDistancePercent: 1.5,
        
        // Multiplikator für die ATR (Average True Range) zur Berechnung des Stops
        // Wenn > 0, wird ATR * atrMultiplier statt eines festen Prozentsatzes verwendet
        atrMultiplier: 0,
        
        // ATR-Zeitraum in Kerzen
        atrPeriod: 14
    },

    // Parameter für den Backtest-Modus
    backtestParams: {
        // Zu testendes Symbol
        symbol: 'BTCUSDT',
        
        // Kerzen-Intervall (1m, 5m, 15m, 1h, 4h, 1d, etc.)
        interval: '1h',
        
        // Startdatum für den Test (ISO-Format)
        startDate: '2023-01-01T00:00:00Z',
        
        // Enddatum für den Test (ISO-Format)
        endDate: '2023-06-30T23:59:59Z'
    }
};

// Funktion zur Validierung einer Konfiguration
export function validateConfig(config) {
    // Hier könnten Validierungen hinzugefügt werden
    // z.B. Prüfung auf gültige Werte, erforderliche Felder, etc.
    
    // Beispiel: Einfache Prüfung auf erforderliche Felder
    const requiredFields = ['tradingMode', 'symbol', 'positionSize'];
    
    for (const field of requiredFields) {
        if (config[field] === undefined) {
            throw new Error(`Missing required configuration field: ${field}`);
        }
    }
    
    return true;
}