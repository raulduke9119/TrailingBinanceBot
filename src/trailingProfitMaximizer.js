import { EventEmitter } from 'events';
import { BinanceClient } from './binanceClient.js';
import { Position } from './position.js';
import { Logger } from './logger.js';
import { DEFAULT_CONFIG, validateConfig } from './config.js';

export class TrailingProfitMaximizer extends EventEmitter {
  constructor(config = {}) {
    super();
    // Merge mit Standardkonfiguration
    this.config = { ...DEFAULT_CONFIG, ...config };
    
    // Validiere die Konfiguration
    validateConfig(this.config);
    
    // Initialisiere Logger
    this.logger = new Logger(this.config.logLevel || 'info');
    this.logger.info(`Initializing TrailingProfitMaximizer in ${this.config.tradingMode.toUpperCase()} mode.`);
    this.emit('log', { level: 'info', message: `Initializing TrailingProfitMaximizer in ${this.config.tradingMode.toUpperCase()} mode.` });
    
    // Initialisiere Binance Client
    this.binanceClient = new BinanceClient(
      process.env.BINANCE_API_KEY,
      process.env.BINANCE_SECRET_KEY,
      this.config.logLevel,
      this.config.tradingMode
    );
    
    // Aktive Positionen
    this.positions = [];
    
    // Profit-Historie für Statistiken
    this.profitHistory = [];
    
    // Timers für regelmäßige Updates
    this.refreshTimer = null;
    this.volatilityTimer = null;
    
    // ATR (Average True Range) für Volatilitätsberechnung
    this.atrValues = {};
    
    // Initialisiere den Bot
    this.init();
  }
  
  async init() {
    try {
      // Teste die Verbindung zur Binance API
      await this.binanceClient.testConnection();
      this.logger.info("Binance API connection successful.");
      
      // Starte Timer für regelmäßige Updates, außer wenn im Backtest-Modus
      if (this.config.refreshInterval !== Infinity) {
        this.startRefreshTimer();
      }
      
      if (this.config.volatilityUpdateInterval !== Infinity) {
        this.startVolatilityTimer();
      }
      
      // Lade alle offenen Positionen (in einer realen Implementierung)
      // await this.loadOpenPositions();
      
    } catch (error) {
      this.logger.error("Error initializing TrailingProfitMaximizer:", error);
      this.emit('error', error);
    }
  }
  
  startRefreshTimer() {
    this.logger.info(`Starting refresh timer with interval ${this.config.refreshInterval}ms.`);
    this.refreshTimer = setInterval(() => this.refreshPrices(), this.config.refreshInterval);
  }
  
  startVolatilityTimer() {
    this.logger.info(`Starting volatility timer with interval ${this.config.volatilityUpdateInterval}ms.`);
    this.volatilityTimer = setInterval(() => this.updateVolatility(), this.config.volatilityUpdateInterval);
  }
  
  stopTimers() {
    if (this.refreshTimer) {
      clearInterval(this.refreshTimer);
      this.refreshTimer = null;
    }
    
    if (this.volatilityTimer) {
      clearInterval(this.volatilityTimer);
      this.volatilityTimer = null;
    }
  }
  
  async refreshPrices() {
    try {
      // Hole die aktuellen Preise für alle aktiven Positionen
      for (const position of this.positions) {
        if (position.status === 'ACTIVE') {
          const priceData = await this.binanceClient.getPrice(position.symbol);
          const currentPrice = parseFloat(priceData.price);
          
          // Aktualisiere den Preis in der Position
          position.currentPrice = currentPrice;
          
          // Aktualisiere den höchsten Preis, wenn der aktuelle Preis höher ist
          if (currentPrice > position.highestPrice) {
            position.highestPrice = currentPrice;
          }
          
          // Aktualisiere den Gewinn/Verlust
          position.updateProfit();
          
          this.logger.debug(`Updated ${position.symbol}: Current price ${currentPrice}, Profit: ${position.profit.toFixed(2)} (${position.profitPercent.toFixed(2)}%)`);
        }
      }
      
      // Aktualisiere Trailing-Stops basierend auf den neuen Preisen
      await this.updateTrailingStops();
      
    } catch (error) {
      this.logger.error("Error refreshing prices:", error);
      this.emit('error', error);
    }
  }
  
  async updateTrailingStops() {
    try {
      // Aktualisiere Trailing-Stops für alle aktiven Positionen
      for (const position of this.positions) {
        if (position.status !== 'ACTIVE') continue;
        
        // Berechne den neuen Trailing-Stop basierend auf den Position-Einstellungen
        const oldStop = position.currentTrailingStop;
        const newStop = position.updateTrailingStop(this.config.trailingStop);
        
        // Wenn sich der Stop geändert hat, aktualisiere die Stop-Order
        if (newStop !== oldStop && position.stopOrderId) {
          this.logger.info(`Updating trailing stop for ${position.symbol} from ${oldStop} to ${newStop}`);
          
          // Storniere die alte Stop-Order und erstelle eine neue
          await this.updateStopOrder(position, newStop);
          
          this.emit('stopUpdated', position);
        }
      }
    } catch (error) {
      this.logger.error("Error updating trailing stops:", error);
      this.emit('error', error);
    }
  }
  
  async updateStopOrder(position, newStopPrice) {
    // Storniere die alte Stop-Order, falls vorhanden
    if (position.stopOrderId) {
      try {
        await this.binanceClient.cancelOrder(position.symbol, position.stopOrderId);
        this.logger.debug(`Cancelled old stop order ${position.stopOrderId} for ${position.symbol}`);
      } catch (error) {
        this.logger.warn(`Error cancelling old stop order for ${position.symbol}:`, error);
        // Wir versuchen trotzdem, eine neue Stop-Order zu erstellen
      }
    }
    
    // Erstelle eine neue Stop-Order
    try {
      // Berechne den Limit-Preis etwas unter dem Stop-Preis (für SELL)
      const limitPrice = newStopPrice * 0.995; // 0.5% unter dem Stop-Preis
      
      const stopOrder = await this.binanceClient.createStopLossOrder(
        position.symbol,
        'SELL',
        position.quantity,
        newStopPrice,
        limitPrice
      );
      
      // Speichere die neue Stop-Order-ID
      position.stopOrderId = stopOrder.orderId;
      this.logger.info(`Created new stop order ${position.stopOrderId} for ${position.symbol} at ${newStopPrice}`);
      
      return stopOrder;
    } catch (error) {
      this.logger.error(`Error creating new stop order for ${position.symbol}:`, error);
      throw error;
    }
  }
  
  async createNewPosition(symbol, quantity) {
    try {
      this.logger.info(`Creating new position for ${symbol} with quantity ${quantity}`);
      
      // Erstelle eine Market-Buy-Order
      const buyOrder = await this.binanceClient.createMarketOrder(symbol, 'BUY', quantity);
      
      // Erstelle eine neue Position
      const position = new Position(
        symbol,
        buyOrder.price, // Ausführungspreis
        buyOrder.executedQty,
        buyOrder.orderId
      );
      
      // Setze die Position auf ACTIVE
      position.status = 'ACTIVE';
      
      // Berechne den initialen Stop-Loss
      const initialStopDistance = position.entryPrice * (this.config.trailingStop.initialStopDistancePercent / 100);
      const initialStopPrice = position.entryPrice - initialStopDistance;
      position.setInitialStop(initialStopPrice);
      
      // Erstelle eine Stop-Loss-Order
      const stopOrder = await this.updateStopOrder(position, initialStopPrice);
      position.stopOrderId = stopOrder.orderId;
      
      // Füge die Position zur Liste hinzu
      this.positions.push(position);
      
      this.logger.info(`Position created for ${symbol} at ${position.entryPrice} with stop at ${initialStopPrice}`);
      this.emit('positionOpened', position);
      
      return position;
    } catch (error) {
      this.logger.error(`Error creating new position for ${symbol}:`, error);
      this.emit('error', error);
      throw error;
    }
  }
  
  async closePosition(position, closePrice, reason = '') {
    try {
      this.logger.info(`Closing position for ${position.symbol} at ${closePrice}. Reason: ${reason}`);
      
      // Nur im Live-Modus eine Market-Sell-Order erstellen
      // Im Paper-Modus oder bei bereits ausgelösten Stops nicht nötig
      if (this.config.tradingMode === 'live' && !reason.includes('StopLoss')) {
        await this.binanceClient.createMarketOrder(position.symbol, 'SELL', position.quantity);
      }
      
      // Position als geschlossen markieren
      position.close(closePrice, reason);
      
      // Zur Profit-Historie hinzufügen
      const trade = {
        symbol: position.symbol,
        entryPrice: position.entryPrice,
        exitPrice: closePrice,
        quantity: position.quantity,
        profit: position.profit,
        profitPercent: position.profitPercent,
        openDate: position.openDate,
        closeDate: position.closeDate,
        holdingTimeMs: position.closeDate - position.openDate,
        stopPrice: position.currentTrailingStop,
        reason: reason
      };
      
      this.profitHistory.push(trade);
      
      this.logger.info(`Position closed for ${position.symbol}. Profit: ${position.profit.toFixed(2)} (${position.profitPercent.toFixed(2)}%)`);
      this.emit('positionClosed', trade);
      
      return trade;
    } catch (error) {
      this.logger.error(`Error closing position for ${position.symbol}:`, error);
      this.emit('error', error);
      throw error;
    }
  }
  
  // Helfer-Methode zum Abrufen aller aktiven Positionen
  getActivePositions() {
    return this.positions.filter(p => p.status === 'ACTIVE');
  }
  
  // Berechnung von Handelsstatistiken
  getStatistics() {
    const stats = {
      totalTrades: this.profitHistory.length,
      winningTrades: 0,
      losingTrades: 0,
      totalProfit: 0,
      totalProfitPercent: 0,
      biggestWin: 0,
      biggestLoss: 0,
      averageProfit: 0,
      averageProfitPercent: 0,
      winRate: 0,
      profitFactor: 0,
      averageHoldingTimeMs: 0,
      averageHoldingTimeHours: 0
    };
    
    if (stats.totalTrades === 0) return stats;
    
    let totalWinAmount = 0;
    let totalLossAmount = 0;
    let totalHoldingTimeMs = 0;
    
    for (const trade of this.profitHistory) {
      stats.totalProfit += trade.profit;
      stats.totalProfitPercent += trade.profitPercent;
      totalHoldingTimeMs += trade.holdingTimeMs;
      
      if (trade.profit > 0) {
        stats.winningTrades++;
        totalWinAmount += trade.profit;
        stats.biggestWin = Math.max(stats.biggestWin, trade.profit);
      } else {
        stats.losingTrades++;
        totalLossAmount += Math.abs(trade.profit);
        stats.biggestLoss = Math.min(stats.biggestLoss, trade.profit);
      }
    }
    
    stats.averageProfit = stats.totalProfit / stats.totalTrades;
    stats.averageProfitPercent = stats.totalProfitPercent / stats.totalTrades;
    stats.winRate = (stats.winningTrades / stats.totalTrades) * 100;
    stats.profitFactor = totalLossAmount > 0 ? totalWinAmount / totalLossAmount : totalWinAmount;
    stats.averageHoldingTimeMs = totalHoldingTimeMs / stats.totalTrades;
    stats.averageHoldingTimeHours = stats.averageHoldingTimeMs / (1000 * 60 * 60);
    
    return stats;
  }
  
  async updateVolatility() {
    try {
      // Für jede aktive Position die ATR berechnen
      for (const position of this.getActivePositions()) {
        // Hole historische Kerzen für ATR-Berechnung
        const klines = await this.binanceClient.getHistoricalKlines(
          position.symbol,
          '1h', // Intervall für ATR
          this.config.trailingStop.atrPeriod + 1 // +1 für Berechnung des ersten TR
        );
        
        if (!klines || klines.length < this.config.trailingStop.atrPeriod) {
          this.logger.warn(`Not enough data for ATR calculation for ${position.symbol}`);
          continue;
        }
        
        // Berechne True Range (TR) für jede Kerze
        const trValues = [];
        for (let i = 1; i < klines.length; i++) {
          const high = parseFloat(klines[i][2]);
          const low = parseFloat(klines[i][3]);
          const prevClose = parseFloat(klines[i-1][4]);
          
          // TR = max(high - low, |high - prevClose|, |low - prevClose|)
          const tr = Math.max(
            high - low,
            Math.abs(high - prevClose),
            Math.abs(low - prevClose)
          );
          
          trValues.push(tr);
        }
        
        // Berechne ATR (einfacher Durchschnitt der TR-Werte)
        const atr = trValues.reduce((sum, tr) => sum + tr, 0) / trValues.length;
        
        // Speichere ATR für das Symbol
        this.atrValues[position.symbol] = atr;
        
        this.logger.debug(`Updated ATR for ${position.symbol}: ${atr}`);
        
        // Wenn ATR-Multiplikator gesetzt ist, aktualisiere den Trailing-Stop
        if (this.config.trailingStop.atrMultiplier > 0) {
          // Hier könnte eine spezielle Logik für ATR-basierte Stops implementiert werden
        }
      }
    } catch (error) {
      this.logger.error("Error updating volatility metrics:", error);
    }
  }
}