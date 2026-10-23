import { ArrowRight, BadgeCheck, CalendarDays, ChevronDown, Info } from "lucide-react";
import { plans, type PlanName } from "@/lib/pricing";
import { formatMoney } from "@/lib/public-ui";

export function PlanCatalogue({ selected, onSelect }: { selected: PlanName; onSelect: (plan: PlanName) => void }) {
  const plan = plans.find(item => item.name === selected) ?? plans[1];
  return (
    <section className="serviceSection pageShell planCatalogue focusedPlanCatalogue" aria-labelledby="plans-heading">
      <div className="pricingHeading">
        <div><p className="sectionLabel">Commercial plans</p><h2 id="plans-heading">Choose your pickup plan.</h2></div>
        <p id="plan-choice-help">Monthly service fee + laundry charged by weight.</p>
      </div>
      <div className="focusedPlanLayout">
        <div className="focusedPlanSelection">
          <fieldset className="focusedPlanFrequency" aria-describedby="plan-choice-help">
            <legend>Pickups per week</legend>
            <div className="focusedPlanSegments">
              {plans.map(item => <label className="focusedPlanSegment" key={item.name}>
                <input className="srOnly" type="radio" name="catalogue-plan" value={item.name} checked={item.name === plan.name} onChange={() => onSelect(item.name)} />
                <span aria-hidden="true">{item.pickups.split(" ")[0]}×</span>
                <span className="srOnly">{item.name}, {item.pickups}</span>
              </label>)}
            </div>
          </fieldset>
          <article className="focusedPlanCard" aria-labelledby="selected-plan-heading">
            <p className="sectionLabel">Selected plan</p>
            <h3 id="selected-plan-heading">{plan.name}</h3>
            <p className="focusedPlanPrice"><strong>{formatMoney(plan.subscription)}</strong><span>/ month</span></p>
            <p className="focusedPlanFee">Monthly service fee</p>
            <ul className="focusedPlanSchedule">
              <li><CalendarDays aria-hidden="true" /><span>{plan.pickups}</span></li>
              <li><CalendarDays aria-hidden="true" /><span>{plan.monthlyPickups} pickups a month</span></li>
            </ul>
          </article>
          <p className="srOnly" role="status" aria-live="polite" aria-atomic="true">{plan.name} selected. {formatMoney(plan.subscription)} monthly service fee, plus laundry charged by weight. {plan.monthlyPickups} pickups a month.</p>
        </div>
        <div className="focusedPlanInformation">
          <details className="focusedPlanDisclosure">
            <summary><span>Compare all {plans.length} plans</span><ChevronDown aria-hidden="true" /></summary>
            <div className="focusedPlanDisclosureBody">
              <p>Monthly service fees. Laundry is charged separately by weight.</p>
              <ul className="focusedPlanComparison" aria-label="All commercial plans">
                {plans.map(item => <li key={item.name}>
                  <button type="button" className="focusedPlanCompareChoice" aria-pressed={item.name === plan.name} onClick={() => onSelect(item.name)} aria-label={`Choose ${item.name}, ${item.pickups}, ${formatMoney(item.subscription)} monthly service fee`}>
                    <span><strong>{item.name}</strong><small>{item.pickups}</small></span>
                    <span className="focusedPlanComparePrice"><strong>{formatMoney(item.subscription)}</strong><small>{item.name === plan.name ? "Selected" : "Choose plan"}</small></span>
                  </button>
                </li>)}
              </ul>
            </div>
          </details>
          <details className="focusedPlanDisclosure">
            <summary><span>What’s included</span><ChevronDown aria-hidden="true" /></summary>
            <div className="focusedPlanDisclosureBody">
              <p>{plan.audience}</p>
              <ul className="planBenefits focusedPlanBenefits" tabIndex={0} aria-label={`${plan.name} included services`}>{plan.features.map(feature => <li key={feature}><BadgeCheck aria-hidden="true" /><span>{feature}</span></li>)}</ul>
            </div>
          </details>
          <details className="focusedPlanDisclosure">
            <summary><span>Laundry rates</span><ChevronDown aria-hidden="true" /></summary>
            <div className="focusedPlanDisclosureBody">
              <p>Rates for {plan.name.toLowerCase()}. The rate applies to the whole load.</p>
              <dl className="planRateList focusedPlanRates" tabIndex={0} aria-label={`${plan.name} laundry rates`}>{plan.bands.map((band, index) => <div key={band.min}><dt>{band.min}{index + 1 < plan.bands.length ? `–under ${plan.bands[index + 1].min}` : "+"} kg</dt><dd>{formatMoney(band.rate)} / kg</dd></div>)}</dl>
            </div>
          </details>
          <p className="focusedPlanMinimum"><Info aria-hidden="true" /><strong>{formatMoney(450)} minimum per pickup.</strong></p>
          <a className="button primary full focusedPlanEstimate" href="#estimate-heading">Estimate my cost <ArrowRight aria-hidden="true" /></a>
          <p className="focusedPlanNote">Laundry is charged separately by weight.</p>
        </div>
      </div>
    </section>
  );
}
