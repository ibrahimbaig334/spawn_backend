import milestoneHookAbi from './abi/MilestoneHook.json';
import launchSupportAbi from './abi/LaunchSupport.json';
import milestoneTokenAbi from './abi/MilestoneToken.json';
import revenueNftAbi from './abi/RevenueNFT.json';
import payoutPluginRegistryAbi from './abi/PayoutPluginRegistry.json';
import protocolControllerAbi from './abi/ProtocolController.json';
import buybackAndBurnPluginAbi from './abi/BuybackAndBurnPlugin.json';
import stateViewAbi from './abi/StateView.json';
import v4QuoterAbi from './abi/V4Quoter.json';

/**
 * Curated ABIs from the integration handoff. Only these are trusted; satellite
 * implementations (MilestoneColdPaths/MilestonePayoutPaths) are deliberately absent —
 * every state-changing entry routes through the hook address.
 */

export const MILESTONE_HOOK_ABI = milestoneHookAbi;
export const LAUNCH_SUPPORT_ABI = launchSupportAbi;
export const MILESTONE_TOKEN_ABI = milestoneTokenAbi;
export const REVENUE_NFT_ABI = revenueNftAbi;
export const PAYOUT_PLUGIN_REGISTRY_ABI = payoutPluginRegistryAbi;
export const PROTOCOL_CONTROLLER_ABI = protocolControllerAbi;
export const BUYBACK_AND_BURN_PLUGIN_ABI = buybackAndBurnPluginAbi;
export const STATE_VIEW_ABI = stateViewAbi;
export const V4_QUOTER_ABI = v4QuoterAbi;
