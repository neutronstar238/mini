#include <bits/stdc++.h>
using namespace std;
int main(){string s="abracadabra",p="cad";vector<int>l(p.size());for(int i=1,j=0;i<(int)p.size();i++){while(j&&p[i]!=p[j])j=l[j-1];if(p[i]==p[j])j++;l[i]=j;}int ans=-1;for(int i=0,j=0;i<(int)s.size();i++){while(j&&s[i]!=p[j])j=l[j-1];if(s[i]==p[j])j++;if(j==(int)p.size()){ans=i-j+1;break;}}cout<<ans<<"\n";}
