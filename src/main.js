import { TrailingProfitMaximizer } from './trailingProfitMaximizer.js';
import { Backtester } from './backtester.js';
import { DEFAULT_CONFIG } from './config.js';
import { Logger } from './logger.js';

// Lade Umgebungsvariablen aus .env Datei
// Hinweis: In einer produktiven Umgebung sollte dotenv verwendet werden
try {
  const dotenv = await import('dotenv');
  dotenv.config();
} catch (error) {
  console.warn("Could not load dotenv module. Proceeding without loading .env file.");
}

// Überprüfe, ob API-Keys vorhanden sind
if (!process.env.BINANCE_API_KEY || !process.env.BINANCE_SECRET_KEY) {
  console.error("Error: Binance API keys not found in environment variables. Please set BINANCE_API_KEY and BINANCE_SECRET_KEY.");
  process.exit(1);
}

// Hauptfunktion
async function main() {
  const logger = new Logger('info');
  logger.info("Starting TrailingBinanceBot...");
  
  // Kommandozeilenargumente parsen
  const args = process.argv.slice(2);
  const mode = args.includes('--backtest') ? 'backtest' : 'live';
  
  // Konfiguration aus Kommandozeilenargumenten
  const config = { ...DEFAULT_CONFIG };
  
  // Log-Level
  if (args.includes('--debug')) {
    config.logLevel = 'debug';
  } else if (args.includes('--quiet')) {
    config.logLevel = 'error';
  }
  
  // Trading-Modus
  if (args.includes('--paper')) {
    config.tradingMode = 'paper';
  } else if (args.includes('--live')) {
    config.tradingMode = 'live';
  }
  
  // Symbol
  const symbolIndex = args.findIndex(arg => arg === '--symbol');
  if (symbolIndex !== -1 && args[symbolIndex + 1]) {
    config.symbol = args[symbolIndex + 1];
  }
  
  // Position Size
  const positionSizeIndex = args.findIndex(arg => arg === '--position-size');
  if (positionSizeIndex !== -1 && args[positionSizeIndex + 1]) {
    config.positionSize = parseFloat(args[positionSizeIndex + 1]);
  }
  
  logger.info(`Running in ${mode.toUpperCase()} mode with ${config.tradingMode.toUpperCase()} trading.`);
  logger.info(`Trading ${config.symbol} with position size ${config.positionSize} USDT.`);
  
  try {
    if (mode === 'backtest') {
      // Backtest-Parameter aus Kommandozeilenargumenten
      const startDateIndex = args.findIndex(arg => arg === '--start-date');
      if (startDateIndex !== -1 && args[startDateIndex + 1]) {
        config.backtestParams.startDate = args[startDateIndex + 1];
      }
      
      const endDateIndex = args.findIndex(arg => arg === '--end-date');
      if (endDateIndex !== -1 && args[endDateIndex + 1]) {
        config.backtestParams.endDate = args[endDateIndex + 1];
      }
      
      const intervalIndex = args.findIndex(arg => arg === '--interval');
      if (intervalIndex !== -1 && args[intervalIndex + 1]) {
        config.backtestParams.interval = args[intervalIndex + 1];
      }
      
      logger.info(`Backtest period: ${config.backtestParams.startDate} to ${config.backtestParams.endDate}`);
      logger.info(`Backtest interval: ${config.backtestParams.interval}`);
      logger.info(`Backtest symbol: ${config.backtestParams.symbol}`);
      
      // Starte Backtest
      const backtester = new Backtester(config);
      const results = await backtester.run();
      
      logger.info("Backtest completed.");
      
      // Zeige detaillierte Ergebnisse
      console.log("\n===== BACKTEST RESULTS =====");
      console.log(`Symbol: ${config.backtestParams.symbol}`);
      console.log(`Period: ${config.backtestParams.startDate} to ${config.backtestParams.endDate}`);
      console.log(`Initial balance: ${results.initialBalance.toFixed(2)} USDT`);
      console.log(`Final balance: ${results.finalBalance.toFixed(2)} USDT`);
      console.log(`Total profit: ${(results.finalBalance - results.initialBalance).toFixed(2)} USDT`);
      console.log(`Return: ${((results.finalBalance / results.initialBalance - 1) * 100).toFixed(2)}%`);
      console.log(`Total trades: ${results.trades.length}`);
      
      if (results.trades.length > 0) {
        const winningTrades = results.trades.filter(t => t.profit > 0);
        console.log(`Winning trades: ${winningTrades.length} (${((winningTrades.length / results.trades.length) * 100).toFixed(2)}%)`);
        
        console.log("\nTrade history:");
        for (const [index, trade] of results.trades.entries()) {
          console.log(`${index + 1}. ${trade.symbol}: ${trade.profit.toFixed(2)} USDT (${trade.profitPercent.toFixed(2)}%) - ${new Date(trade.openDate).toISOString().split('T')[0]} to ${new Date(trade.closeDate).toISOString().split('T')[0]}`);
        }
      }
      
    } else {
      // Live-Modus
      logger.info("Starting bot in live mode...");
      
      // Initialisiere Bot
      const bot = new TrailingProfitMaximizer(config);
      
      // Event-Listener
      bot.on('positionOpened', (position) => {
        logger.info(`Position opened: ${position.symbol} at ${position.entryPrice}`);
      });
      
      bot.on('positionClosed', (trade) => {
        logger.info(`Position closed: ${trade.symbol} at ${trade.exitPrice}. Profit: ${trade.profit.toFixed(2)} (${trade.profitPercent.toFixed(2)}%)`);
      });
      
      bot.on('stopUpdated', (position) => {
        logger.info(`Stop updated for ${position.symbol}: New stop at ${position.currentTrailingStop}`);
      });
      
      bot.on('error', (error) => {
        logger.error("Bot error:", error);
      });
      
      // Beispiel für manuelles Eröffnen einer Position
      if (args.includes('--open-position')) {
        setTimeout(async () => {
          try {
            logger.info(`Opening test position for ${config.symbol}...`);
            await bot.createNewPosition(config.symbol, config.positionSize / (await bot.binanceClient.getPrice(config.symbol)).price);
          } catch (error) {
            logger.error("Error opening test position:", error);
          }
        }, 5000); // 5 Sekunden warten, damit der Bot vollständig initialisiert ist
      }
      
      // Aufräumen bei Programmende
      process.on('SIGINT', async () => {
        logger.info("Shutting down bot...");
        bot.stopTimers();
        
        // Optional: Alle offenen Positionen schließen
        if (args.includes('--close-on-exit')) {
          logger.info("Closing all positions before exit...");
          for (const position of bot.getActivePositions()) {
            try {
              const currentPrice = (await bot.binanceClient.getPrice(position.symbol)).price;
              await bot.closePosition(position, currentPrice, 'Program shutdown');
            } catch (error) {
              logger.error(`Error closing position ${position.symbol}:`, error);
            }
          }
        }
        
        process.exit(0);
      });
    }
  } catch (error) {
    logger.error("Fatal error:", error);
    process.exit(1);
  }
}

// Starte den Bot
main().catch(error => {
  console.error("Unhandled error:", error);
  process.exit(1);
});