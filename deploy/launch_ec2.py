#!/usr/bin/env python3
"""Launch an EC2 instance and deploy EchoGuide backend with HTTPS via Caddy + nip.io.

Prerequisites:
    pip install boto3
    aws configure   (Access Key, Secret Key, region, output=json)

Usage:
    python deploy/launch_ec2.py
    python deploy/launch_ec2.py --region us-east-1 --instance-type t3.small
"""

from __future__ import annotations

import argparse
import base64
import os
import sys
import time
from pathlib import Path

try:
    import boto3
    from botocore.exceptions import ClientError
except ImportError:
    sys.exit("Install boto3 first:  pip install boto3")

# ── Ubuntu 24.04 LTS AMI IDs (us-east-1 … ap-southeast-1) ───────────────────
AMI_IDS: dict[str, str] = {
    "us-east-1":      "ami-0c7217cdde317cfec",
    "us-east-2":      "ami-0aed7f3a1c88bc0d3",
    "us-west-1":      "ami-0ce2cb35386fc22e9",
    "us-west-2":      "ami-008fe2fc65df48dac",
    "eu-west-1":      "ami-0905a3c97561e0b69",
    "eu-central-1":   "ami-06dd92ecc74fdfb36",
    "ap-southeast-1": "ami-078c1149d8ad719a7",
    "ap-northeast-1": "ami-0d52744d6551d851e",
}

KEY_NAME = "echoguide-key"
SG_NAME  = "echoguide-sg"
TAG_NAME = "EchoGuide"


# ── helpers ───────────────────────────────────────────────────────────────────

def ask(prompt: str, default: str = "") -> str:
    val = input(f"{prompt} [{default}]: ").strip() if default else input(f"{prompt}: ").strip()
    return val or default


def ask_secret(prompt: str) -> str:
    import getpass
    return getpass.getpass(f"{prompt}: ").strip()


def get_or_create_key_pair(ec2, region: str) -> str:
    """Return local .pem path, creating the key pair in AWS if needed."""
    pem_path = Path(f"{KEY_NAME}.pem")
    try:
        ec2.describe_key_pairs(KeyNames=[KEY_NAME])
        if pem_path.exists():
            print(f"  Re-using existing key pair '{KEY_NAME}' → {pem_path}")
            return str(pem_path)
        print(f"  Key pair '{KEY_NAME}' exists in AWS but {pem_path} not found locally.")
        print("  Delete it in the AWS console and re-run, or provide your existing .pem.")
        sys.exit(1)
    except ClientError:
        pass  # doesn't exist — create it

    print(f"  Creating key pair '{KEY_NAME}' …")
    resp = ec2.create_key_pair(KeyName=KEY_NAME, KeyType="rsa", KeyFormat="pem")
    pem_path.write_text(resp["KeyMaterial"])
    try:
        os.chmod(str(pem_path), 0o600)
    except Exception:
        pass
    print(f"  Private key saved to {pem_path}  (keep it safe!)")
    return str(pem_path)


def get_or_create_security_group(ec2) -> str:
    """Return security group ID, creating it if needed."""
    vpcs = ec2.describe_vpcs(Filters=[{"Name": "isDefault", "Values": ["true"]}])
    vpc_id = vpcs["Vpcs"][0]["VpcId"]

    try:
        sgs = ec2.describe_security_groups(
            Filters=[{"Name": "group-name", "Values": [SG_NAME]},
                     {"Name": "vpc-id",    "Values": [vpc_id]}]
        )
        if sgs["SecurityGroups"]:
            sg_id = sgs["SecurityGroups"][0]["GroupId"]
            print(f"  Re-using security group '{SG_NAME}' ({sg_id})")
            return sg_id
    except ClientError:
        pass

    print(f"  Creating security group '{SG_NAME}' …")
    sg = ec2.create_security_group(
        GroupName=SG_NAME,
        Description="EchoGuide — SSH + HTTP + HTTPS",
        VpcId=vpc_id,
    )
    sg_id = sg["GroupId"]
    ec2.authorize_security_group_ingress(
        GroupId=sg_id,
        IpPermissions=[
            {"IpProtocol": "tcp", "FromPort": 22,  "ToPort": 22,  "IpRanges": [{"CidrIp": "0.0.0.0/0"}]},
            {"IpProtocol": "tcp", "FromPort": 80,  "ToPort": 80,  "IpRanges": [{"CidrIp": "0.0.0.0/0"}]},
            {"IpProtocol": "tcp", "FromPort": 443, "ToPort": 443, "IpRanges": [{"CidrIp": "0.0.0.0/0"}]},
            {"IpProtocol": "tcp", "FromPort": 22,  "ToPort": 22,  "Ipv6Ranges": [{"CidrIpv6": "::/0"}]},
            {"IpProtocol": "tcp", "FromPort": 80,  "ToPort": 80,  "Ipv6Ranges": [{"CidrIpv6": "::/0"}]},
            {"IpProtocol": "tcp", "FromPort": 443, "ToPort": 443, "Ipv6Ranges": [{"CidrIpv6": "::/0"}]},
        ],
    )
    print(f"  Security group created: {sg_id}")
    return sg_id


def build_user_data(
    gemini_key: str,
    elevenlabs_key: str,
    mapbox_token: str,
    le_email: str,
) -> str:
    """Read server_setup.sh and substitute placeholders."""
    template = (Path(__file__).parent / "server_setup.sh").read_text()
    script = (
        template
        .replace("%%GEMINI_API_KEY%%",        gemini_key)
        .replace("%%ELEVENLABS_API_KEY%%",    elevenlabs_key)
        .replace("%%MAPBOX_ACCESS_TOKEN%%",   mapbox_token)
        .replace("%%LETSENCRYPT_EMAIL%%",     le_email)
    )
    return base64.b64encode(script.encode()).decode()


# ── main ──────────────────────────────────────────────────────────────────────

def main() -> None:
    parser = argparse.ArgumentParser(description="Deploy EchoGuide to EC2 with HTTPS.")
    parser.add_argument("--region",        default="us-east-1")
    parser.add_argument("--instance-type", default="t3.small")
    parser.add_argument("--volume-gb",     type=int, default=20)
    args = parser.parse_args()

    region = args.region
    if region not in AMI_IDS:
        sys.exit(f"Region '{region}' not in supported list: {list(AMI_IDS)}")

    print("\n=== EchoGuide EC2 Deployment ===\n")
    print("You will need your API keys. They are written to the .env on the server only.\n")

    gemini_key     = ask_secret("GEMINI_API_KEY")
    elevenlabs_key = ask_secret("ELEVENLABS_API_KEY (leave blank to skip)")
    mapbox_token   = ask_secret("MAPBOX_ACCESS_TOKEN (leave blank to skip)")
    le_email       = ask("Email for Let's Encrypt SSL certificate")

    if not le_email or "@" not in le_email:
        sys.exit("A valid email is required for Let's Encrypt.")

    ec2 = boto3.client("ec2", region_name=region)

    print(f"\n[1/5] Key pair …")
    pem_path = get_or_create_key_pair(ec2, region)

    print("[2/5] Security group …")
    sg_id = get_or_create_security_group(ec2)

    print("[3/5] Building user-data script …")
    user_data = build_user_data(gemini_key, elevenlabs_key, mapbox_token, le_email)

    print(f"[4/5] Launching {args.instance_type} in {region} …")
    resp = ec2.run_instances(
        ImageId=AMI_IDS[region],
        InstanceType=args.instance_type,
        MinCount=1, MaxCount=1,
        KeyName=KEY_NAME,
        SecurityGroupIds=[sg_id],
        UserData=user_data,
        BlockDeviceMappings=[{
            "DeviceName": "/dev/sda1",
            "Ebs": {"VolumeSize": args.volume_gb, "VolumeType": "gp3", "DeleteOnTermination": True},
        }],
        TagSpecifications=[{
            "ResourceType": "instance",
            "Tags": [{"Key": "Name", "Value": TAG_NAME}],
        }],
    )
    instance_id = resp["Instances"][0]["InstanceId"]
    print(f"  Instance ID: {instance_id}")

    print("[5/5] Waiting for public IP (this may take ~60 s) …")
    waiter = ec2.get_waiter("instance_running")
    waiter.wait(InstanceIds=[instance_id])
    desc = ec2.describe_instances(InstanceIds=[instance_id])
    public_ip = desc["Reservations"][0]["Instances"][0].get("PublicIpAddress", "")

    if not public_ip:
        print("  Could not get public IP yet — check the AWS console.")
        return

    domain = f"{public_ip}.nip.io"
    https_url = f"https://{domain}"

    print(f"""
=== Deployment complete ===

  Instance:  {instance_id}
  Public IP: {public_ip}
  Domain:    {domain}
  App URL:   {https_url}    ← open this in a browser

NOTE: The server setup script is still running in the background (~3-5 min).
      Watch progress:
        ssh -i {pem_path} ubuntu@{public_ip}
        tail -f /var/log/echoguide_setup.log

UPDATE your React Native app:
  Open  mobile/src/config.js
  Set   export const BACKEND_URL = "{https_url}";
  Then rebuild the app.

SSH command:
  ssh -i {pem_path} ubuntu@{public_ip}
""")

    # Save the URL so the mobile app can find it
    config_path = Path(__file__).parents[1] / "mobile" / "src" / "config.js"
    if config_path.exists():
        text = config_path.read_text()
        updated = text.replace("https://YOUR_EC2_IP.nip.io", https_url)
        if updated != text:
            config_path.write_text(updated)
            print(f"  Auto-updated {config_path} with {https_url}")


if __name__ == "__main__":
    main()
