function genererCode(prefixe) {
  const chars = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
  let code = "";
  for (let i = 0; i < 6; i++) {
    code += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return `${prefixe}-${code}`;
}

function formatDate(timestamp) {
  if (!timestamp) return "—";
  const date = timestamp.toDate ? timestamp.toDate() : new Date(timestamp);
  return date.toLocaleDateString("fr-FR");
}

function formatMontant(montant) {
  return new Intl.NumberFormat("fr-FR").format(Math.round(montant || 0)) + " GNF";
}

function notifier(message, type) {
  const existant = document.getElementById("notif-toast");
  if (existant) existant.remove();

  const toast = document.createElement("div");
  toast.id = "notif-toast";
  toast.textContent = message;
  Object.assign(toast.style, {
    position: "fixed",
    bottom: "20px",
    left: "50%",
    transform: "translateX(-50%)",
    background: type === "erreur" ? "#C0392B" : "#1B4332",
    color: "white",
    padding: "12px 20px",
    borderRadius: "10px",
    fontSize: "14px",
    zIndex: 2000,
    maxWidth: "90%",
    textAlign: "center",
    boxShadow: "0 4px 12px rgba(0,0,0,0.2)",
  });
  document.body.appendChild(toast);
  setTimeout(() => toast.remove(), 3500);
}

export { genererCode, formatDate, formatMontant, notifier };
