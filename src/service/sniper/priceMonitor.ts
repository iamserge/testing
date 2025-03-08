interface PriceData {
  initialPrice: number;
  threshold: number;
  duration: number;
  startTime: number;
}

export class PriceMonitor {
  private data: PriceData;
  private tokenMint: string; // Store token mint for better logging

  constructor(thresholdPercent: number, durationSec: number, initialPrice: number, tokenMint: string = "unknown") {
    // Ensure parameters are valid
    const safeThreshold = typeof thresholdPercent === 'number' && !isNaN(thresholdPercent) ? thresholdPercent : 5;
    const safeDuration = typeof durationSec === 'number' && !isNaN(durationSec) && durationSec > 0 ? durationSec : 60;
    const safeInitialPrice = typeof initialPrice === 'number' && !isNaN(initialPrice) && initialPrice > 0 ? 
      initialPrice : 0.000000001; // Avoid zero
    
    this.data = {
      initialPrice: safeInitialPrice,
      threshold: safeThreshold / 100,
      duration: safeDuration * 1000, // Convert to milliseconds
      startTime: Date.now(),
    };
    this.tokenMint = tokenMint;
    
    // Log monitor creation
    console.log(`[🔄 PriceMonitor:${tokenMint.slice(0, 8)}...] Created with initial price $${safeInitialPrice.toFixed(6)}, threshold ${safeThreshold}%, duration ${safeDuration}s`);
  }

  shouldSell(currentPrice: number): boolean {
    const currentTime = Date.now();
    const elapsedTime = currentTime - this.data.startTime;

    // Only log every 15 minutes to avoid excessive logging
    if (Math.floor(currentTime / 900000) !== Math.floor(this.data.startTime / 900000)) {
      const minutesElapsed = Math.floor(elapsedTime / 60000);
      const secondsElapsed = Math.floor((elapsedTime % 60000) / 1000);
      console.log(`[🔍 PriceMonitor:${this.tokenMint.slice(0, 8)}...] Elapsed: ${minutesElapsed}m ${secondsElapsed}s, Current: $${currentPrice.toFixed(6)}, Initial: $${this.data.initialPrice.toFixed(6)}`);
    }

    if (elapsedTime >= this.data.duration) {
      // Protect against division by zero or negative initial price
      if (this.data.initialPrice <= 0) {
        console.log(`[⚠️ PriceMonitor:${this.tokenMint.slice(0, 8)}...] WARNING: Initial price is ${this.data.initialPrice}. Setting to current price and resetting timer.`);
        this.data.initialPrice = Math.max(0.000000001, currentPrice); // Avoid zero
        this.data.startTime = currentTime;
        return false;
      }
      
      const priceChange = (currentPrice - this.data.initialPrice) / this.data.initialPrice;
      const priceChangePercent = priceChange * 100;
      const minRequiredPercent = this.data.threshold * 100;
      
      console.log(`[⏱️ PriceMonitor:${this.tokenMint.slice(0, 8)}...] Duration elapsed (${elapsedTime}ms). Price change: ${priceChangePercent.toFixed(2)}%, Required: ${minRequiredPercent.toFixed(2)}%`);
      
      if (priceChange < this.data.threshold) {
        console.log(`[🚨 PriceMonitor:${this.tokenMint.slice(0, 8)}...] SELLING SIGNAL: Insufficient price growth (${priceChangePercent.toFixed(2)}% < required ${minRequiredPercent.toFixed(2)}%)`);
        return true;
      }
      
      console.log(`[🔄 PriceMonitor:${this.tokenMint.slice(0, 8)}...] Resetting monitor with new initial price $${currentPrice.toFixed(6)}`);
      this.data.initialPrice = currentPrice;
      this.data.startTime = currentTime;
    }
    return false;
  }

  // Helper methods for status reporting
  getStatus(): { 
    initialPrice: number; 
    currentThreshold: number; 
    durationMs: number; 
    startTime: number; 
    elapsedPercent: number;
    requiredGrowthPercent: number;
  } {
    const now = Date.now();
    const elapsed = now - this.data.startTime;
    return {
      initialPrice: this.data.initialPrice,
      currentThreshold: this.data.threshold,
      durationMs: this.data.duration,
      startTime: this.data.startTime,
      elapsedPercent: Math.min(100, (elapsed / this.data.duration) * 100),
      requiredGrowthPercent: this.data.threshold * 100
    };
  }

  getRemainingTimeSeconds(): number {
    const now = Date.now();
    const elapsed = now - this.data.startTime;
    const remaining = Math.max(0, this.data.duration - elapsed);
    return Math.floor(remaining / 1000);
  }
}