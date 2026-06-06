# signal_proc.py — LMS filter, FFT features, normalization
import math


class LMSFilter:
  def __init__(self, mu=0.01):
    self.mu = mu
    self.w = 0.0

  def update(self, x):
    x = float(x)
    err = x - self.w
    self.w += self.mu * err
    return self.w


class FFTProcessor:
  def __init__(self, n=32):
    self.n = n

  def magnitudes(self, signal):
    N = min(len(signal), self.n)
    if N < 2:
      return [0.0] * (self.n // 2)
    real = [float(signal[i]) for i in range(N)]
    mags = []
    for k in range(self.n // 2):
      re = sum(real[n] * math.cos(2 * math.pi * k * n / N) for n in range(N))
      im = sum(real[n] * math.sin(2 * math.pi * k * n / N) for n in range(N))
      mags.append(math.sqrt(re * re + im * im) / N)
    return mags


class Normalizer:
  def scale(self, v, lo, hi):
    return (float(v) - lo) / (hi - lo + 1e-8)
