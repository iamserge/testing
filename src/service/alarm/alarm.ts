import { AlertService } from "../../models/Alert";
import { IAlertMsg } from "../../utils/types";

// Create new alert
export const createAlert = async (alertData: IAlertMsg) => {
  const newAlert = new AlertService(alertData);
  return await newAlert.save();
};

// Get all alerts sorted by time
export const getAllAlerts = async () => {
  return await AlertService.find().sort({ time: -1 });
};


// Delete alert
export const deleteAlert = async (id: string) => {
  return await AlertService.findByIdAndDelete(id);
};

// Get unread alerts
export const getUnreadAlerts = async () => {
  return await AlertService.find({ isRead: false }).sort({ time: -1 });
};

// Get unread alerts count
export const getUnreadAlertsCount = async () => {
  return await AlertService.countDocuments({ isRead: false });
};

// Mark alert as read
export const markAlertAsRead = async (id: string) => {
  return await AlertService.findByIdAndUpdate(
    id,
    { isRead: true },
    { new: true }
  );
};

// Mark all alerts as read
export const markAllAlertsAsRead = async () => {
  return await AlertService.updateMany({ isRead: false }, { isRead: true });
};
