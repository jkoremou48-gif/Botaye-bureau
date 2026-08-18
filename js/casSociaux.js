// Règle d'éligibilité à l'assistance sociale (instructions du bureau BÖTAYE) :
// une famille absente à 70% ou plus des cas sociaux de l'année ET en retard
// sur 50% ou plus des cotisations de l'année n'a pas droit à une nouvelle assistance.
const SEUIL_ABSENCE_POURCENT = 70;
const SEUIL_RETARD_POURCENT = 50;

function casDes12DerniersMois(socialCases) {
  const limite = new Date();
  limite.setFullYear(limite.getFullYear() - 1);
  return socialCases.filter((c) => {
    const d = c.date_creation?.toDate?.();
    return d && d >= limite;
  });
}

// Calcule le taux d'absence d'une famille aux cas sociaux de l'association sur 12 mois.
// Ne compte que les cas où la présence de cette famille a été explicitement enregistrée.
function calculerTauxAbsenceCasSociaux(familleId, socialCases) {
  const casRecents = casDes12DerniersMois(socialCases);
  let total = 0;
  let absences = 0;
  casRecents.forEach((c) => {
    const p = c.participations || {};
    if (p[familleId]) {
      total++;
      if (p[familleId] === "absent") absences++;
    }
  });
  if (total === 0) return null; // pas assez de données pour juger
  return Math.round((absences / total) * 100);
}

// Détermine l'éligibilité d'une famille à une nouvelle assistance sociale.
function evaluerEligibiliteAssistance(familleId, socialCases, tauxRetardPaiement) {
  const tauxAbsence = calculerTauxAbsenceCasSociaux(familleId, socialCases);
  const absenceElevee = tauxAbsence !== null && tauxAbsence >= SEUIL_ABSENCE_POURCENT;
  const retardEleve = tauxRetardPaiement !== null && tauxRetardPaiement >= SEUIL_RETARD_POURCENT;
  return {
    eligible: !(absenceElevee && retardEleve),
    tauxAbsence,
    tauxRetardPaiement,
    motif: (absenceElevee && retardEleve)
      ? `Absence à ${tauxAbsence}% des cas sociaux et retard de ${tauxRetardPaiement}% des cotisations sur l'année.`
      : null,
  };
}

function genererReferenceCas() {
  const chars = "0123456789";
  let n = "";
  for (let i = 0; i < 6; i++) n += chars.charAt(Math.floor(Math.random() * chars.length));
  return `CS-${n}`;
}

export { evaluerEligibiliteAssistance, calculerTauxAbsenceCasSociaux, genererReferenceCas, SEUIL_ABSENCE_POURCENT, SEUIL_RETARD_POURCENT };
