import { BadgeCheck } from "lucide-react";
import { plans, type PlanName } from "@/lib/pricing";
import { formatMoney } from "@/lib/public-ui";

export function PlanCatalogue({ selected, onSelect }: { selected: PlanName; onSelect: (plan: PlanName) => void }) {
  const plan = plans.find(item => item.name === selected) ?? plans[1];
  return (
    <section className="serviceSection pageShell planCatalogue" aria-labelledby="plans-heading">
      <div className="pricingHeading"><div><p className="sectionLabel">Commercial plans</p><h2 id="plans-heading">Choose your pickup rhythm.</h2></div><p>Each plan combines a monthly service fee with processing by weight. A GHS 450 minimum applies per pickup.</p></div>
      <fieldset className="planChoices" aria-describedby="plan-choice-help">
        <legend className="srOnly">Collection plan</legend>
        {plans.map(item => <label className="planChoice" key={item.name}>
          <span className="planChoiceName"><input type="radio" name="catalogue-plan" value={item.name} checked={item.name === plan.name} onChange={() => onSelect(item.name)} /><strong>{item.name}</strong></span>
          <span className="planChoiceSchedule">{item.pickups}</span>
          <span className="cataloguePrice"><strong>{formatMoney(item.subscription)}</strong><span>service fee / month</span></span>
        </label>)}
      </fieldset>
      <p id="plan-choice-help" className="planChoiceHelp">Choose a plan to see its rates and estimate below.</p>
      <div className="selectedPlanDetails">
        <div><h3>{plan.name} includes {plan.monthlyPickups} pickups a month.</h3><p>{plan.audience}</p><details className="planDetails"><summary>What’s included</summary><ul className="planBenefits">{plan.features.map(feature => <li key={feature}><BadgeCheck aria-hidden="true" />{feature}</li>)}</ul></details></div>
        <div><h4>Processing per pickup</h4><dl className="planRateList">{plan.bands.map((band, index) => <div key={band.min}><dt>{band.min}{index + 1 < plan.bands.length ? `–under ${plan.bands[index + 1].min}` : "+"} kg</dt><dd>{formatMoney(band.rate)} / kg</dd></div>)}</dl><p className="planRateNote">The rate applies to the whole load.</p></div>
      </div>
    </section>
  );
}
