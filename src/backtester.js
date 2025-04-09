import { BinanceClient } from './binanceClient.js';
import { TrailingProfitMaximizer } from './trailingProfitMaximizer.js';
import { Logger } from './logger.js';
import { DEFAULT_CONFIG } from './config.js';

export class Backtester {
  constructor(config) {
    this.config = { ...DEFAULT_CONFIG, ...config }; // Merge mit Standardkonfig
    this.logger = new Logger(this.config.logLevel || 'info');
    this.backtestParams = this.config.backtestParams;

    if (!this.backtestParams) {
      throw new Error("Backtest parameters are missing in the configuration.");
    }

    // Binance Client wird nur zum Laden historischer Daten benötigt
    // API Keys werden aus der Umgebung geladen (wie im Original)
    // Wir verwenden hier den 'paper' Modus, da wir keine echten Orders senden
    this.dataClient = new BinanceClient(
        process.env.BINANCE_API_KEY,
        process.env.BINANCE_SECRET_KEY,
        this.config.logLevel,
        'paper' // Nur für Datenabruf
    );

    // Hier wird später die Instanz des Bots für die Simulation erstellt
    this.simulatedBot = null;
    this.historicalData = [];
    this.results = {
        trades: [],
        finalBalance: 0,
        // Weitere Metriken...
    };

    this.logger.info("Backtester initialized.");
    this.maxKlinesPerRequest = 1000; // Binance API limit
  }

  // Hilfsfunktion zur Berechnung der Millisekunden pro Intervall
  getIntervalMilliseconds(interval) {
      const unit = interval.slice(-1);
      const value = parseInt(interval.slice(0, -1));
      switch (unit) {
          case 'm': return value * 60 * 1000;
          case 'h': return value * 60 * 60 * 1000;
          case 'd': return value * 24 * 60 * 60 * 1000;
          case 'w': return value * 7 * 24 * 60 * 60 * 1000;
          // 'M' (Monat) ist ungenau, vermeiden oder speziell behandeln
          default: throw new Error(`Unsupported interval unit: ${unit}`);
      }
  }

  async loadHistoricalData() {
    this.logger.info(`Loading historical data for ${this.backtestParams.symbol} (${this.backtestParams.interval}) from ${this.backtestParams.startDate} to ${this.backtestParams.endDate}...`);
    this.historicalData = []; // Reset data

    try {
        let currentStartTime = new Date(this.backtestParams.startDate).getTime();
        const finalEndTime = new Date(this.backtestParams.endDate).getTime();
        const intervalMs = this.getIntervalMilliseconds(this.backtestParams.interval);

        while (currentStartTime < finalEndTime) {
            // Berechne das Enddatum für diesen Chunk (max 1000 Kerzen)
            let currentEndTime = currentStartTime + (this.maxKlinesPerRequest -1) * intervalMs;
            // Stelle sicher, dass wir nicht über das gewünschte Enddatum hinausgehen
            currentEndTime = Math.min(currentEndTime, finalEndTime);

            this.logger.debug(`Fetching klines from ${new Date(currentStartTime).toISOString()} to ${new Date(currentEndTime).toISOString()}...`);

            // Lade Klines für den aktuellen Chunk
            // node-binance-api's candles Funktion unterstützt startTime und endTime
            const klinesChunk = await this.dataClient.binance.candles(
                this.backtestParams.symbol,
                this.backtestParams.interval,
                {
                    startTime: currentStartTime,
                    endTime: currentEndTime, // endTime ist inklusiv bei der API? Doku prüfen. Annahme: exklusiv.
                    limit: this.maxKlinesPerRequest
                }
            );

             // Formatieren der Daten, wie es getHistoricalKlines tun würde
             const formattedChunk = klinesChunk.map(k => [
                 k.openTime, k.open, k.high, k.low, k.close, k.volume,
                 k.closeTime, k.quoteVolume, k.trades, k.buyVolume,
                 k.buyQuoteVolume, k.ignored
             ]);


            if (formattedChunk && formattedChunk.length > 0) {
                this.historicalData = this.historicalData.concat(formattedChunk);
                this.logger.debug(`Loaded ${formattedChunk.length} klines in this chunk. Total loaded: ${this.historicalData.length}`);
                // Setze die Startzeit für den nächsten Chunk auf die Zeit der *letzten* Kerze + 1 Intervall
                currentStartTime = formattedChunk[formattedChunk.length - 1][0] + intervalMs; // [0] ist openTime
            } else {
                this.logger.debug("No more data returned in this chunk or empty chunk.");
                break; // Keine Daten mehr im Zeitraum oder Lücke
            }

            // Kurze Pause, um API-Limits nicht zu überschreiten
            await new Promise(resolve => setTimeout(resolve, 300)); // 300ms Pause
        }

        // Filtere Daten, um sicherzustellen, dass sie im exakten Zeitbereich liegen (falls API ungenau ist)
        const finalStartTime = new Date(this.backtestParams.startDate).getTime();
        this.historicalData = this.historicalData.filter(kline => kline[0] >= finalStartTime && kline[6] <= finalEndTime); // [0]=openTime, [6]=closeTime

        // Entferne Duplikate basierend auf der Open Time
        const uniqueData = [];
        const seenTimestamps = new Set();
        for (const kline of this.historicalData) {
            if (!seenTimestamps.has(kline[0])) {
                uniqueData.push(kline);
                seenTimestamps.add(kline[0]);
            }
        }
        this.historicalData = uniqueData;
        // Sortiere zur Sicherheit nach Zeit
        this.historicalData.sort((a, b) => a[0] - b[0]);


        if (this.historicalData.length === 0) {
            throw new Error("No historical data loaded after filtering/chunking. Check parameters or Binance API availability.");
        }

        this.logger.info(`Finished loading data. Total unique klines loaded: ${this.historicalData.length}`);

    } catch (error) {
        this.logger.error("Error loading historical data:", error);
        throw error; // Fehler weiterwerfen, um den Backtest abzubrechen
    }
  }

  async run() {
    this.logger.info("Starting backtest run...");
    await this.loadHistoricalData();

    if (this.historicalData.length === 0) {
        this.logger.error("Cannot run backtest without historical data.");
        return null;
    }

    // Initialisiere den Bot für die Simulation im 'paper' Modus
    // Wir übergeben eine spezielle Konfiguration für den Backtest
    const backtestBotConfig = {
        ...this.config,
        tradingMode: 'paper', // Wichtig: Nutzt die Simulationslogik im BinanceClient
        logLevel: this.config.logLevel, // Behalte den Log-Level bei
        // Deaktiviere ggf. interne Intervalle des Bots, da wir die Zeit steuern
        refreshInterval: Infinity, // Verhindert den internen Loop
        volatilityUpdateInterval: Infinity, // Verhindert automatische ATR-Updates
    };
    this.simulatedBot = new TrailingProfitMaximizer(backtestBotConfig);
    // Verbinde UI-Logs des simulierten Bots mit dem Backtester-Logger
    this.simulatedBot.on('log', (logData) => {
        this.logger[logData.level || 'info'](`[SimulatedBot] ${logData.message}`);
    });
     this.simulatedBot.on('positionOpened', (pos) => this.logger.info(`[Backtest] Simulated Position Opened: ${pos.symbol}`));
     this.simulatedBot.on('positionClosed', (trade) => {
         this.logger.info(`[Backtest] Simulated Position Closed: ${trade.symbol}, Profit: ${trade.profit.toFixed(2)}`);
         this.results.trades.push(trade); // Trade zum Ergebnis hinzufügen
     });
     this.simulatedBot.on('stopUpdated', (pos) => this.logger.info(`[Backtest] Simulated Stop Updated: ${pos.symbol} to ${pos.currentTrailingStop}`));


    // Initialisiere simuliertes Konto (Beispiel)
    this.results.initialBalance = 10000; // Startkapital USDT
    this.results.currentBalance = this.results.initialBalance;
    this.logger.info(`Starting simulation with initial balance: ${this.results.initialBalance} USDT`);


    this.logger.info(`Starting simulation loop over ${this.historicalData.length} klines...`);

    // --- Simulations-Loop ---
    // for (const kline of this.historicalData) {
    //   const timestamp = kline[0];
    //   const open = parseFloat(kline[1]);
    //   const high = parseFloat(kline[2]);
    //   const low = parseFloat(kline[3]);
    //   const close = parseFloat(kline[4]);
    //   const volume = parseFloat(kline[5]);
    //
    //   // 1. Update simulierten Bot mit neuen Preisdaten (z.B. close)
    //   //    simulatedBot.processKline({ timestamp, open, high, low, close, volume });
    //
    //   // 2. Prüfe, ob Orders ausgelöst wurden (Stop-Loss, Take-Profit)
    //   //    - Basierend auf high/low der aktuellen Kerze
    //
    //   // 3. Führe Bot-Logik aus (z.B. updateTrailingStops basierend auf close)
    //
    //   // 4. Simuliere Order-Ausführung für neue Signale
    //   //    - Basierend auf Preisen der *nächsten* Kerze (z.B. open)
    //
    //   // 5. Aktualisiere simuliertes Konto und Positionen
    //
    //   // 6. Logge Trades
    // }
    for (let i = 0; i < this.historicalData.length; i++) {
      const kline = this.historicalData[i];
      const timestamp = kline[0];
      const open = parseFloat(kline[1]);
      const high = parseFloat(kline[2]);
      const low = parseFloat(kline[3]);
      const close = parseFloat(kline[4]);
      // const volume = parseFloat(kline[5]); // Volumen wird aktuell nicht verwendet

      this.logger.debug(`Processing kline ${i + 1}/${this.historicalData.length}: Time: ${new Date(timestamp).toISOString()}, O: ${open}, H: ${high}, L: ${low}, C: ${close}`);

      // --- Simulation der Preisbewegung innerhalb der Kerze ---
      // Vereinfachte Annahme: Wir prüfen Stops gegen High/Low und aktualisieren basierend auf Close.

      const activePositions = this.simulatedBot.getActivePositions();

      for (const position of activePositions) {
          // 1. Update aktuellen Preis (für Profitberechnung etc.) auf den Schlusskurs der Kerze
          position.currentPrice = close;
          position.updateProfit(); // Internen Profit aktualisieren

          // 2. Prüfe Stop-Loss Auslösung durch das Kerzen-Tief
          // Wichtig: Nur prüfen, wenn ein Stop gesetzt wurde!
          if (position.currentTrailingStop > 0 && low <= position.currentTrailingStop) {
              this.logger.info(`[Backtest] Stop triggered for ${position.symbol} at kline ${i+1}. Low (${low}) <= Stop (${position.currentTrailingStop}). Closing position.`);
              // Schließe die Position zum Stop-Preis (simulierte Ausführung)
              // Der closePosition Call nutzt den BinanceClient im Paper-Modus, der eine simulierte Order zurückgibt
              await this.simulatedBot.closePosition(position, position.currentTrailingStop, 'StopLoss (Backtest)');
              // Da die Position geschlossen wurde, überspringe weitere Verarbeitung für diese Position in dieser Kerze
              continue; // Nächste Position prüfen
          }

          // 3. Update höchsten Preis (basierend auf Kerzen-Hoch) und Trailing Stop (basierend auf Schlusskurs)
          // Wir müssen den höchsten Preis *vor* der Stop-Aktualisierung setzen
          if (high > position.highestPrice) {
              position.highestPrice = high;
              this.logger.debug(`[Backtest] New highest price for ${position.symbol}: ${high}`);
          }

          // Führe die Logik zur Stop-Aktualisierung aus (nutzt intern position.currentPrice = close)
          // Diese Methode versucht auch, die Order im (Paper) BinanceClient zu aktualisieren
          if (position.status === 'ACTIVE') { // Nur wenn noch aktiv
             await this.simulatedBot.updateTrailingStops(); // Läuft über *alle* Positionen, aber wir sind im Loop pro Position... -> Besser: Nur für diese Position? Nein, die Methode ist für alle gedacht.
          }
      }
       // Führe updateTrailingStops *nach* der Preisaktualisierung aller Positionen aus
       await this.simulatedBot.updateTrailingStops();


      // --- Simulation neuer Einstiege (vereinfacht) ---
      // Hier könnte Logik stehen, die entscheidet, ob eine neue Position eröffnet wird.
      // Beispiel: Kaufe, wenn Preis X erreicht.
      // const shouldOpenPosition = someStrategyLogic(close);
      // if (shouldOpenPosition) {
      //    const nextKlineOpen = (i + 1 < this.historicalData.length) ? parseFloat(this.historicalData[i+1][1]) : close;
      //    this.logger.info(`[Backtest] Strategy triggered BUY for ${this.backtestParams.symbol} at kline ${i+1}. Simulating buy at next open: ${nextKlineOpen}`);
      //    // Menge basierend auf Startkapital und Risiko berechnen
      //    const positionSize = calculatePositionSize(this.results.currentBalance, nextKlineOpen, riskPerTrade);
      //    await this.simulatedBot.createNewPosition(this.backtestParams.symbol, positionSize);
      // }


      // TODO: Aktualisiere simuliertes Kapital basierend auf P/L geschlossener Trades (passiert implizit durch closePosition -> results.trades)
    }
    // --- Ende Simulations-Loop ---


    // Berechne finale Statistiken
    // Final balance = initial balance + sum of profits/losses from trades
    const totalProfit = this.results.trades.reduce((sum, trade) => sum + (trade.profit || 0), 0);
    this.results.finalBalance = this.results.initialBalance + totalProfit;

    const stats = this.simulatedBot.getStatistics(); // Nutze Statistik-Funktion des Bots (basiert auf this.simulatedBot.profitHistory)

    this.logger.info("Backtest run finished.");
    this.logger.info("--- Backtest Summary ---");
    this.logger.info(`Period: ${this.backtestParams.startDate} to ${this.backtestParams.endDate}`);
    this.logger.info(`Symbol: ${this.backtestParams.symbol}, Interval: ${this.backtestParams.interval}`);
    this.logger.info(`Total Trades: ${stats.totalTrades}`);
    this.logger.info(`Total Profit: ${stats.totalProfit} USDT`); // Annahme USDT
    this.logger.info(`Win Rate: ${stats.winRate}%`);
    this.logger.info(`Profit Factor: ${stats.profitFactor}`);
    this.logger.info(`Average Holding Time: ${stats.averageHoldingTimeHours} hours`);
    this.logger.info(`Initial Balance: ${this.results.initialBalance.toFixed(2)} USDT`);
    this.logger.info(`Final Balance: ${this.results.finalBalance.toFixed(2)} USDT`);

    // Stelle sicher, dass die Statistiken im Bot auch aktuell sind (sollten sie durch closePosition sein)
    if (JSON.stringify(stats) !== JSON.stringify(this.simulatedBot.getStatistics())) {
        this.logger.warn("Mismatch between backtester trade results and bot internal statistics. Recalculating bot stats.");
        // Ggf. hier die Statistikberechnung im Bot erneut anstoßen, falls nötig
    }


    return { ...this.results, statistics: stats }; // Gib gesammelte Ergebnisse und Statistiken zurück
  }
}