# tinyml.py — Alerts for temperature + oximeter (HR)
class EdgeInference:
    THRESHOLDS = {
        "temp_high": 38.0,
        "temp_low": 10.0,
        "hr_high": 120,
        "hr_low": 50,
    }

    def infer(self, temp, hr):
        alerts = []
        if temp is not None and temp > self.THRESHOLDS["temp_high"]:
            alerts.append({"type": "TEMP_HIGH", "val": temp})
        if temp is not None and temp < self.THRESHOLDS["temp_low"]:
            alerts.append({"type": "TEMP_LOW", "val": temp})
        if hr is not None and hr > self.THRESHOLDS["hr_high"]:
            alerts.append({"type": "HR_HIGH", "val": hr})
        if hr is not None and hr < self.THRESHOLDS["hr_low"]:
            alerts.append({"type": "HR_LOW", "val": hr})
        return {
            "alert": len(alerts) > 0,
            "alerts": alerts,
            "class": "ANOMALY" if alerts else "NORMAL",
            "confidence": 0.93,
        }
