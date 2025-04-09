// Klasse zur Repräsentation einer Handelsposition
export class Position {
  constructor(symbol, entryPrice, quantity, openOrderId = null) {
    this.symbol = symbol;
    this.entryPrice = parseFloat(entryPrice);
    this.quantity = parseFloat(quantity);
    this.openDate = new Date();
    this.closeDate = null;
    
    // Order-IDs für Tracking und Management
    this.openOrderId = openOrderId;
    this.stopOrderId = null;
    
    // Preis-Tracking
    this.highestPrice = this.entryPrice; // Höchster erreichter Preis seit Eröffnung
    this.currentPrice = this.entryPrice; // Aktueller Preis für Berechnungen
    
    // Stop-Loss Einstellungen
    this.initialStopPrice = 0; // Wird später gesetzt
    this.currentTrailingStop = 0; // Wird später gesetzt
    
    // Status der Position
    this.status = "OPENING"; // OPENING, ACTIVE, CLOSING, CLOSED
    
    // Gewinn/Verlust
    this.profit = 0; // Realisierter oder unrealisierter Gewinn/Verlust
    this.profitPercent = 0; // Gewinn/Verlust in Prozent
    
    // Trailing-Stop Einstellungen (können pro Position überschrieben werden)
    this.trailingSettings = {
      initialStopDistancePercent: null, // Initialabstand in Prozent
      activationThresholdPercent: null, // Ab wann Trailing aktivieren
      trailingDistancePercent: null     // Trailing-Abstand in Prozent
    };
    
    // Notizen/Metadaten
    this.notes = "";
    this.tags = [];
  }
  
  // Aktualisiert den aktuellen Preis und berechnet den unrealisierten Gewinn/Verlust
  updateProfit() {
    if (!this.currentPrice) return;
    
    // Berechnung basierend auf Long-Position (Kauf)
    const currentValue = this.quantity * this.currentPrice;
    const entryValue = this.quantity * this.entryPrice;
    
    this.profit = currentValue - entryValue;
    this.profitPercent = ((this.currentPrice / this.entryPrice) - 1) * 100;
    
    return {
      profit: this.profit,
      profitPercent: this.profitPercent
    };
  }
  
  // Setzt den initialen Stop-Loss
  setInitialStop(stopPrice) {
    this.initialStopPrice = parseFloat(stopPrice);
    this.currentTrailingStop = this.initialStopPrice;
    return this.currentTrailingStop;
  }
  
  // Aktualisiert den Trailing-Stop basierend auf dem aktuellen Preis und den Einstellungen
  updateTrailingStop(settings = {}) {
    // Wenn keine Settings übergeben wurden, verwende die der Position oder Standardwerte
    const activeSettings = {
      initialStopDistancePercent: settings.initialStopDistancePercent || this.trailingSettings.initialStopDistancePercent || 2,
      activationThresholdPercent: settings.activationThresholdPercent || this.trailingSettings.activationThresholdPercent || 1,
      trailingDistancePercent: settings.trailingDistancePercent || this.trailingSettings.trailingDistancePercent || 1.5
    };
    
    // Aktualisiere die Position-spezifischen Einstellungen
    Object.assign(this.trailingSettings, activeSettings);
    
    // Wenn der Stop noch nicht gesetzt wurde, setze ihn basierend auf initialStopDistancePercent
    if (this.currentTrailingStop === 0) {
      const stopDistance = this.entryPrice * (activeSettings.initialStopDistancePercent / 100);
      this.setInitialStop(this.entryPrice - stopDistance);
      return this.currentTrailingStop;
    }
    
    // Berechne den aktuellen Gewinn in Prozent
    this.updateProfit();
    
    // Wenn der Gewinn unter dem Aktivierungsschwellenwert liegt, behalte den aktuellen Stop bei
    if (this.profitPercent < activeSettings.activationThresholdPercent) {
      return this.currentTrailingStop;
    }
    
    // Berechne den neuen möglichen Stop basierend auf dem höchsten Preis
    const trailingDistance = this.highestPrice * (activeSettings.trailingDistancePercent / 100);
    const newPossibleStop = this.highestPrice - trailingDistance;
    
    // Ziehe den Stop nur nach oben, nie nach unten
    if (newPossibleStop > this.currentTrailingStop) {
      this.currentTrailingStop = newPossibleStop;
    }
    
    return this.currentTrailingStop;
  }
  
  // Schließt die Position
  close(closePrice, closeReason = '') {
    if (this.status === 'CLOSED') {
      return false; // Bereits geschlossen
    }
    
    this.closeDate = new Date();
    this.currentPrice = parseFloat(closePrice);
    this.updateProfit(); // Aktualisiere den finalen Gewinn/Verlust
    this.status = 'CLOSED';
    this.notes += closeReason ? ` Closed: ${closeReason}` : ' Closed.';
    
    return true;
  }
  
  // Gibt eine JSON-Repräsentation der Position zurück
  toJSON() {
    return {
      symbol: this.symbol,
      entryPrice: this.entryPrice,
      quantity: this.quantity,
      openDate: this.openDate,
      closeDate: this.closeDate,
      openOrderId: this.openOrderId,
      stopOrderId: this.stopOrderId,
      highestPrice: this.highestPrice,
      currentPrice: this.currentPrice,
      initialStopPrice: this.initialStopPrice,
      currentTrailingStop: this.currentTrailingStop,
      status: this.status,
      profit: this.profit,
      profitPercent: this.profitPercent,
      trailingSettings: { ...this.trailingSettings },
      notes: this.notes,
      tags: [...this.tags]
    };
  }
}